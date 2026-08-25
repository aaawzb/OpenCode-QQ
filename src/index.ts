import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import { Approver } from "./approver.js"
import { loadConfig } from "./config.js"
import { createGatewayUrlFetcher, QQGateway } from "./qq/gateway.js"
import { QQApi } from "./qq/api.js"
import { AuthManager } from "./qq/auth.js"
import { StreamSender } from "./qq/stream.js"
import {
  SESSIONS_PATH,
  REST_BASE_PROD,
  REST_BASE_SANDBOX,
  INTENT_GROUP_AND_C2C,
  INTENT_INTERACTION,
  APPROVAL_TIMEOUT_MS,
  PASSIVE_WINDOW_MS,
  STREAM_FLUSH_INTERVAL_MS,
} from "./constants.js"
import { EventPusher } from "./event-pusher.js"
import { toolExecuteAfterHook } from "./relay.js"
import { AssistantTextBuffer } from "./stream-buffer.js"
import { SingleInstanceLock } from "./lock.js"
import { SessionManager, type OpencodeBridge } from "./session-manager.js"
import { splitText } from "./util/chunk.js"
import { guessImageMime, toImageDataUrl } from "./util/media.js"
import { buildAckKeyboard, buildApprovalKeyboard, buildReplyKeyboard } from "./keyboard.js"
import { handleInteraction, type InteractionDeps } from "./interactions.js"

type OcEvent = { type: string; properties: Record<string, unknown> }

export const QQBotPlugin: Plugin = async (input) => {
  const cfg = loadConfig()
  if (!cfg) {
    await input.client.app
      .log({
        body: {
          service: "opencode-qq",
          level: "warn",
          message: "缺少 QQ_BOT_APPID/QQ_BOT_APPSECRET 或配置文件，插件未启用",
        },
      })
      .catch(() => {})
    return {}
  }

  // 桌面版会为每个项目实例各加载一次插件；用单实例锁保证只有一个网关在收发，
  // 否则同一条 QQ 消息会被处理 N 次、用户收到 N 条重复回复。
  // 待命实例每 30 秒重试抢锁：持有者崩溃（锁 45 秒无心跳即过期）后自动接管。
  const instanceLock = new SingleInstanceLock(`${SESSIONS_PATH()}.lock`)
  let gatewayActive = false
  const lockRetry: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (gatewayActive) return
    if (instanceLock.acquire()) {
      gatewayActive = true
      if (lockRetry) clearInterval(lockRetry)
      gateway.start()
      void input.client.app
        .log({
          body: { service: "opencode-qq", level: "info", message: "已获得单实例锁，QQ 网关启动" },
        })
        .catch(() => {})
    }
  }, 30_000)
  lockRetry.unref?.()
  if (!instanceLock.acquire()) {
    await input.client.app
      .log({
        body: {
          service: "opencode-qq",
          level: "info",
          message: "检测到其他 opencode 实例已启用 QQ 网关，本实例待命（每 30 秒重试接管）",
        },
      })
      .catch(() => {})
  } else {
    gatewayActive = true
    if (lockRetry) clearInterval(lockRetry)
  }

  const allowSet = new Set(cfg.allowlist)
  const restBase = cfg.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD

  const auth = new AuthManager(cfg.appId, cfg.appSecret)
  const api = new QQApi({ restBase, getToken: () => auth.getToken() })
  const approver = new Approver(APPROVAL_TIMEOUT_MS)

  // ---- opencode 桥接 ----
  let cachedModel: { providerID: string; modelID: string } | null = null
  const bridge: OpencodeBridge = {
    async sessionCreate(title) {
      const res = await input.client.session.create({ body: { title } })
      return { id: res.data!.id }
    },
    async sessionPrompt(id, text, noReply, files) {
      if (!cachedModel) {
        if (cfg.model) {
          const [providerID, modelID] = cfg.model.split("/")
          cachedModel = { providerID, modelID }
        } else {
          const conf = await input.client.config.get()
          const m = (conf.data as { model?: string } | undefined)?.model
          if (!m) throw new Error("未配置 model，请在 opencode-qq.json 中设置 model: 'providerID/modelID'")
          const [providerID, modelID] = m.split("/")
          cachedModel = { providerID, modelID }
        }
      }
      const res = await input.client.session.prompt({
        path: { id },
        body: {
          model: cachedModel,
          noReply,
          parts: [
            { type: "text", text },
            ...(files ?? []).map((f) => ({ type: "file" as const, mime: f.mime, url: f.dataUrl })),
          ],
        },
      })
      return { parts: (res.data as { parts?: Array<{ type: string; text?: string }> } | undefined)?.parts ?? [] }
    },
    resolveModel: async () => {
      if (!cachedModel) await bridge.sessionPrompt("__warm__", "", true).catch(() => {})
      return cachedModel ?? { providerID: "unknown", modelID: "unknown" }
    },
  }

  const sessions = new SessionManager(
    bridge,
    SESSIONS_PATH(),
    fs,
    (sid) => approver.countBySession(sid), // 终审 I4a：/status 附带待审批数
  )
  // /new 重置会话时清空该会话的待审请求（规格第 5 节）
  bridge.onSessionReset = (sid) => approver.clearSession(sid)

  // ---- 事件订阅收集器（EventPusher 用）----
  const listeners: Array<(e: OcEvent) => void> = []

  // 终审 C1：流式缓冲（delta 增量 / part.id 快照替换，仅 assistant 角色）
  const assistantBuf = new AssistantTextBuffer((sid) => sessions.isOurSession(sid))

  const pusher = new EventPusher({
    isOurSession: (sid) => sessions.isOurSession(sid),
    openidOfSession: (sid) => {
      for (const [openid, s] of Object.entries(sessions.snapshot()))
        if (s === sid) return openid
      return null
    },
    send: async (openid, text) => {
      for (const part of splitText(text)) await api.sendC2C(openid, part)
    },
    toolProgress: cfg.events.toolProgress,
    lastAssistantText: (sid) => assistantBuf.text(sid), // 终审 I4b
    subscribe: (h) => listeners.push(h),
  })

  // ---- 下行：QQ 消息处理 ----
  const passiveRefs = new Map<string, { msgId: string; receivedAt: number }>() // openid → 最近一条
  const pendingNotice = new Map<string, string>() // openid → 超窗未送达说明

  // ---- 流式输出（stream_messages 打字机，延迟 begin）----
  // 不再用占位文本提前 begin：监听到首批增量后才创建 sender 并以该批文本为首片，
  // 保证后续 replace 全量正文以上游已下发前缀开头（否则 40007）
  interface StreamCtx {
    sender: StreamSender | null
    msgId: string
    lastLen: number
  }
  const streams = new Map<string, StreamCtx>()

  /** 登记流式意图并返回句柄；返回 null 表示本次不启用流式 */
  const beginStream = (openid: string): StreamCtx | null => {
    if (!cfg.streaming) return null
    const ref = passiveRefs.get(openid)
    if (!ref) return null
    const old = streams.get(openid)
    if (old?.sender) old.sender.failed = true // 重入保护：旧流作废，其排队报文与收尾全部失效
    const ctx: StreamCtx = { sender: null, msgId: ref.msgId, lastLen: 0 }
    streams.set(openid, ctx)
    return ctx
  }

  /** 返回 true 表示流式已送达全文，无需再发普通回复；handle 用于归属校验防误收尾 */
  const endStream = (openid: string, fullText: string, handle: StreamCtx | null): boolean => {
    const ctx = streams.get(openid)
    if (!handle || ctx !== handle) return false // 已被更新的消息覆盖，不碰新流
    streams.delete(openid)
    if (!handle.sender || handle.sender.failed) return false // 失败 → 回落普通回复
    if (!handle.sender.delivered) return false // 从未成功发出任何分片 → 回落普通回复
    void handle.sender.finish(fullText)
    return true
  }

  async function replyTo(
    openid: string,
    text: string,
    format: "text" | "markdown" = "text",
    keyboard?: unknown,
    eventId?: string,
  ): Promise<void> {
    // 纯文本消息不渲染 keyboard：挂按钮时强制 markdown
    if (keyboard && format === "text") format = "markdown"
    const ref = passiveRefs.get(openid)
    const chunks = splitText(text)
    for (const chunk of chunks) {
      const usePassive = !!ref && Date.now() - ref.receivedAt < PASSIVE_WINDOW_MS
      const opts = eventId
        ? { eventId, format, keyboard }
        : usePassive
          ? { msgId: ref!.msgId, format, keyboard }
          : { format, keyboard }
      try {
        await api.sendC2C(openid, chunk, opts)
      } catch {
        if (!usePassive && !eventId) pendingNotice.set(openid, "（此前有未能送达的消息）")
      }
    }
  }

  /** keyboard 开关统一入口：关闭时返回 undefined（纯文本） */
  const kb = (k: () => unknown) => (cfg.keyboard ? k() : undefined)

  const gateway = new QQGateway({
    getGatewayUrl: createGatewayUrlFetcher(restBase, () => auth.getToken()),
    getToken: () => auth.getToken(),
    intents: INTENT_GROUP_AND_C2C | INTENT_INTERACTION,
    interaction: (evt) => void handleInteraction(evt, interactionDeps),
    connected: () => pusher.setOnline(true),
    disconnected: () => pusher.setOnline(false),
    message: async (msg) => {
      let stream: StreamCtx | null = null
      try {
        if (allowSet.size > 0 && !allowSet.has(msg.openid)) return
        passiveRefs.set(msg.openid, { msgId: msg.msgId, receivedAt: Date.now() })
        await replyTo(msg.openid, "已收到，处理中…", "text", kb(() => buildAckKeyboard(msg.openid)))

        // 远程审批回复优先
        const parsed = approver.parseReply(msg.content.trim())
        if (parsed) {
          const item = approver.confirm(parsed.seq)
          if (!item) {
            await replyTo(msg.openid, `#${parsed.seq} 不存在或已超时。`)
            return
          }
          await input.client.postSessionIdPermissionsPermissionId({
            path: { id: item.sessionId, permissionID: item.permissionId },
            body: { response: parsed.reply },
          })
          await replyTo(msg.openid, `已${parsed.reply === "once" ? "批准" : "拒绝"} #${parsed.seq}`)
          return
        }

        const notice = pendingNotice.get(msg.openid)
        pendingNotice.delete(msg.openid)

        // 附件下载为 data URL（多模态 file part），失败降级为纯文字
        const files: Array<{ mime: string; dataUrl: string }> = []
        for (const att of msg.attachments ?? []) {
          try {
            files.push({ mime: guessImageMime(att.url), dataUrl: await toImageDataUrl(att.url) })
          } catch {
            await replyTo(msg.openid, "⚠️ 图片下载失败，仅处理文字部分").catch(() => {})
          }
        }
        const promptText =
          (msg.quotedText ? `[引用消息] ${msg.quotedText}\n` : "") +
          (files.length ? `[图片 x${files.length}] ` : "") +
          msg.content
        stream = beginStream(msg.openid)
        const answer = await sessions.dispatch(msg.openid, promptText, files)
        const deliveredByStream = endStream(msg.openid, answer, stream)
        if (!deliveredByStream) {
          await replyTo(
            msg.openid,
            (notice ? `${notice}\n` : "") + answer,
            cfg.markdownReply ? "markdown" : "text",
            kb(() => buildReplyKeyboard(msg.openid)),
          )
        }
      } catch (e) {
        if (stream && streams.get(msg.openid) === stream) streams.delete(msg.openid) // 仅清理仍归属本次的流
        await replyTo(msg.openid, `处理失败: ${String(e).slice(0, 200)}`).catch(() => {})
      }
    },
  })

  // permission.asked → 编号推送（新版 opencode 事件名为 permission.updated，两者都接）
  listeners.push((e) => {
    if (e.type !== "permission.asked" && e.type !== "permission.updated") return
    const p = e.properties ?? {}
    const sessionId = String(p.sessionID ?? "")
    const permissionId = String(p.id ?? "")
    if (!sessions.isOurSession(sessionId) || !permissionId) return
    const summary = String(p.title ?? p.type ?? "需要授权")
    const seq = approver.register(sessionId, permissionId, summary)
    const openid = (() => {
      for (const [o, s] of Object.entries(sessions.snapshot())) if (s === sessionId) return o
      return null
    })()
    if (openid) {
      void replyTo(openid, approver.render(seq), "text", kb(() => buildApprovalKeyboard(seq, openid)))
    }
  })

  // ---- 互动事件（按钮点击）→ 审批代答路由 ----
  const interactionDeps: InteractionDeps = {
    put: (id, code) => api.putInteraction(id, code),
    confirm: (seq) => approver.confirm(seq),
    respond: async (sessionId, permissionId, reply) => {
      await input.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: reply },
      })
    },
    sendViaEvent: (openid, eventId, text) => replyTo(openid, text, "text", undefined, eventId),
  }

  // ---- 流式增量：assistant 文本累计 → 节流推送 stream_messages ----
  // 终审 C1：message.part.updated 的 part 是全量快照、专用增量字段是 delta
  // （SDK: EventMessagePartUpdated.properties = { part: Part; delta?: string }）。
  // AssistantTextBuffer 优先消费 delta 做增量累计，delta 缺失时按 part.id 快照替换；
  // 并通过 message.updated 建立的 messageID → role 映射只累计 assistant 消息文本。
  listeners.push((e) => {
    assistantBuf.handle(e)
    if (e.type === "session.idle" || e.type === "session.error") {
      assistantBuf.clear(String(e.properties?.sessionID ?? ""))
    }
  })

  const flushTimer = setInterval(() => {
    const snapshot = sessions.snapshot()
    for (const [openid, sid] of Object.entries(snapshot)) {
      const bufText = assistantBuf.text(sid)
      if (!bufText) continue
      const ctx = streams.get(openid)
      if (!ctx || ctx.sender?.failed) continue
      if (!ctx.sender) {
        // 延迟 begin：首批累计文本即首片，此后全量正文天然以其为前缀
        ctx.sender = new StreamSender(
          { restBase, getToken: () => auth.getToken() },
          { openid, msgId: ctx.msgId, msgSeq: /* seq 由 ack 已占 1 */ 2 },
        )
      }
      if (bufText.length <= ctx.lastLen) continue // 无新增内容不重发
      ctx.lastLen = bufText.length
      void ctx.sender.update(bufText)
    }
  }, STREAM_FLUSH_INTERVAL_MS)

  // 网关启动由单实例锁仲裁：抢到锁立即启动，否则由 lockRetry 稍后接管时启动
  if (gatewayActive) gateway.start()

  return {
    event: async ({ event }) => {
      for (const h of listeners) h({ type: event.type, properties: event.properties ?? {} })
    },
    // 终审 I1：tool.execute.after 是 Hooks 回调而非总线事件，这里合成总线形状
    // 事件交给 listeners 分发，EventPusher 的节流推送据此触发
    "tool.execute.after": toolExecuteAfterHook((e) => {
      for (const h of listeners) h(e)
    }),
    dispose: async () => {
      if (lockRetry) clearInterval(lockRetry)
      clearInterval(flushTimer)
      assistantBuf.clearAll()
      gateway.stop()
      pusher.dispose()
      if (gatewayActive) instanceLock.release()
    },
  }
}
