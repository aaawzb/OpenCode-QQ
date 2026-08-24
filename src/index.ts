import type { Plugin } from "@opencode-ai/plugin"
import { Approver } from "./approver"
import { loadConfig } from "./config"
import { createGatewayUrlFetcher, QQGateway } from "./qq/gateway"
import { QQApi } from "./qq/api"
import { AuthManager } from "./qq/auth"
import { StreamSender } from "./qq/stream"
import {
  SESSIONS_PATH,
  REST_BASE_PROD,
  REST_BASE_SANDBOX,
  INTENT_GROUP_AND_C2C,
  APPROVAL_TIMEOUT_MS,
  PASSIVE_WINDOW_MS,
  STREAM_FLUSH_INTERVAL_MS,
} from "./constants"
import { EventPusher } from "./event-pusher"
import { SessionManager, type OpencodeBridge } from "./session-manager"
import { splitText } from "./util/chunk"
import { guessImageMime, toImageDataUrl } from "./util/media"

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

  const sessions = new SessionManager(bridge, SESSIONS_PATH())
  // /new 重置会话时清空该会话的待审请求（规格第 5 节）
  bridge.onSessionReset = (sid) => approver.clearSession(sid)

  // ---- 事件订阅收集器（EventPusher 用）----
  const listeners: Array<(e: OcEvent) => void> = []

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
    subscribe: (h) => listeners.push(h),
  })

  // ---- 下行：QQ 消息处理 ----
  const passiveRefs = new Map<string, { msgId: string; receivedAt: number }>() // openid → 最近一条
  const pendingNotice = new Map<string, string>() // openid → 超窗未送达说明

  // ---- 流式输出（stream_messages 打字机）----
  const streams = new Map<string, { sender: StreamSender; lastLen: number; consumed: boolean }>()

  const beginStream = (openid: string, msgId: string): void => {
    if (!cfg.streaming) return
    const ref = passiveRefs.get(openid)
    if (!ref) return
    const sender = new StreamSender({ restBase, getToken: () => auth.getToken() })
    streams.set(openid, { sender, lastLen: 0, consumed: false })
    void sender.begin(openid, ref.msgId, /* seq 由 ack 已占 1 */ 2, "正在生成…")
  }

  /** 返回 true 表示流式已送达全文，无需再发普通回复 */
  function endStream(openid: string, fullText: string): boolean {
    const ctx = streams.get(openid)
    streams.delete(openid)
    if (!ctx || ctx.sender.failed) return false // 回落普通回复
    ctx.consumed = true
    void ctx.sender.finish(fullText)
    return true
  }

  async function replyTo(openid: string, text: string, format: "text" | "markdown" = "text"): Promise<void> {
    const ref = passiveRefs.get(openid)
    const chunks = splitText(text)
    for (const chunk of chunks) {
      const usePassive = !!ref && Date.now() - ref.receivedAt < PASSIVE_WINDOW_MS
      try {
        await api.sendC2C(openid, chunk, usePassive ? { msgId: ref!.msgId, format } : { format })
      } catch {
        if (!usePassive) pendingNotice.set(openid, "（此前有未能送达的消息）")
      }
    }
  }

  const gateway = new QQGateway({
    getGatewayUrl: createGatewayUrlFetcher(restBase),
    getToken: () => auth.getToken(),
    intents: INTENT_GROUP_AND_C2C,
    connected: () => pusher.setOnline(true),
    disconnected: () => pusher.setOnline(false),
    message: async (msg) => {
      try {
        if (allowSet.size > 0 && !allowSet.has(msg.openid)) return
        passiveRefs.set(msg.openid, { msgId: msg.msgId, receivedAt: Date.now() })
        await replyTo(msg.openid, "已收到，处理中…")

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
        beginStream(msg.openid, msg.msgId)
        const answer = await sessions.dispatch(msg.openid, promptText, files)
        const deliveredByStream = endStream(msg.openid, answer)
        if (!deliveredByStream) {
          await replyTo(msg.openid, (notice ? `${notice}\n` : "") + answer, cfg.markdownReply ? "markdown" : "text")
        }
      } catch (e) {
        streams.delete(msg.openid) // 异常终止时清理流式会话，避免悬挂
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
    if (openid) void replyTo(openid, approver.render(seq))
  })

  // ---- 流式增量：assistant 文本累计 → 节流推送 stream_messages ----
  // message.part.updated 的 part 文本按"增量追加"处理；若真机验证为快照语义，
  // 将 prev + part.text 改为 part.text 即可（见简报步骤 15.5 说明）
  const assistantBuf = new Map<string, string>() // sessionID → 累计 assistant 文本
  listeners.push((e) => {
    const p = e.properties ?? {}
    const sid = String(p.sessionID ?? "")
    if (e.type === "message.part.updated" && sid && sessions.isOurSession(sid)) {
      const part = p.part as { type?: string; text?: string } | undefined
      if (part?.type === "text") {
        const prev = assistantBuf.get(sid) ?? ""
        assistantBuf.set(sid, prev + (part.text ?? ""))
      }
      return
    }
    if (e.type === "session.idle" || e.type === "session.error") assistantBuf.delete(sid)
  })

  const flushTimer = setInterval(() => {
    const snapshot = sessions.snapshot()
    for (const [sid, bufText] of assistantBuf) {
      if (!bufText) continue
      const openid = Object.keys(snapshot).find((o) => snapshot[o] === sid)
      if (!openid) continue
      const ctx = streams.get(openid)
      if (!ctx || ctx.sender.failed || ctx.consumed) continue
      if (bufText.length <= ctx.lastLen) continue // 无新增内容不重发
      ctx.lastLen = bufText.length
      void ctx.sender.update(bufText)
    }
  }, STREAM_FLUSH_INTERVAL_MS)

  gateway.start()

  return {
    event: async ({ event }) => {
      for (const h of listeners) h({ type: event.type, properties: event.properties ?? {} })
    },
    dispose: async () => {
      clearInterval(flushTimer)
      assistantBuf.clear()
      gateway.stop()
      pusher.dispose()
    },
  }
}
