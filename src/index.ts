import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
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
import { SessionManager, type OpencodeBridge, type SessionOps } from "./session-manager.js"
import { listModelPresetsWithBuiltin, listWorkdirs, readOpencodeConfig } from "./presets.js"
import { splitText } from "./util/chunk.js"
import { saveAttachment, toImageDataUrl } from "./util/media.js"
import {
  buildAckKeyboard,
  buildApprovalKeyboard,
  buildDefaultMenuPanel,
  buildReplyKeyboard,
} from "./keyboard.js"
import { handleInteraction, type InteractionDeps } from "./interactions.js"
import { qqLog } from "./errors.js"

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
  let menuSynced = false
  const syncMenu = async (): Promise<void> => {
    if (menuSynced || !cfg.keyboard) return
    menuSynced = true
    try {
      await api.setMenu(buildDefaultMenuPanel())
      await input.client.app
        .log({ body: { service: "opencode-qq", level: "info", message: "自定义菜单已同步" } })
        .catch(() => {})
    } catch (e) {
      menuSynced = false // 允许下次锁接管时重试
      qqLog("menu", "MENU_SET_FAIL", String(e).slice(0, 150))
    }
  }
  const lockRetry: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (gatewayActive) return
    if (instanceLock.acquire()) {
      gatewayActive = true
      if (lockRetry) clearInterval(lockRetry)
      gateway.start()
      void syncMenu()
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
    void syncMenu()
  }

  const allowSet = new Set(cfg.allowlist)
  const restBase = cfg.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD

  const auth = new AuthManager(cfg.appId, cfg.appSecret)
  const api = new QQApi({ restBase, getToken: () => auth.getToken() })
  const approver = new Approver(APPROVAL_TIMEOUT_MS)

  // ---- opencode 桥接 ----
  let cachedModel: { providerID: string; modelID: string } | null = null
  const bridge: OpencodeBridge = {
    async sessionCreate(title, directory) {
      // 显式绑定目录：否则会话落到 sidecar 默认目录，桌面端切换项目后看不到
      const res = await input.client.session.create({
        body: { title },
        query: { directory: directory ?? input.directory },
      })
      return { id: res.data!.id }
    },
    async sessionPrompt(id, text, noReply, files, opts) {
      let model = opts?.model ?? cachedModel
      if (!model) {
        if (cfg.model) {
          const [providerID, modelID] = cfg.model.split("/")
          model = { providerID, modelID }
        } else {
          const conf = await input.client.config.get()
          const m = (conf.data as { model?: string } | undefined)?.model
          if (!m) throw new Error("未配置 model，请在 opencode-qq.json 中设置 model: 'providerID/modelID'")
          const [providerID, modelID] = m.split("/")
          model = { providerID, modelID }
        }
        cachedModel = model
      }
      const directory = opts?.directory
      const res = await input.client.session.prompt({
        path: { id },
        body: {
          model,
          noReply,
          parts: [
            { type: "text", text },
            ...(files ?? []).map((f) => ({ type: "file" as const, mime: f.mime, url: f.dataUrl })),
          ],
        },
        query: directory ? { directory } : undefined,
      })
      return { parts: (res.data as { parts?: Array<{ type: string; text?: string }> } | undefined)?.parts ?? [] }
    },
    resolveModel: async () => {
      if (!cachedModel) await bridge.sessionPrompt("__warm__", "", true).catch(() => {})
      return cachedModel ?? { providerID: "unknown", modelID: "unknown" }
    },
    async sessionInterrupt(sessionId, directory) {
      await input.client.session.abort({
        path: { id: sessionId },
        query: directory ? { directory } : undefined,
      })
    },
    async sessionList(directory) {
      const res = await input.client.session.list({ query: directory ? { directory } : undefined })
      const arr = (res.data ?? []) as Array<{ id: string; title?: string }>
      return arr.map((s) => ({ id: s.id, title: s.title ?? "" }))
    },
  }

  // ---- 模型/工作区/会话查询能力（/model /workdir /session 指令用）----
  const serverAuth = `opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`
  const ops: SessionOps = {
    listModels: () => listModelPresetsWithBuiltin(readOpencodeConfig()),
    defaultModel: () => {
      if (cachedModel) return cachedModel
      if (cfg.model) {
        const [providerID, modelID] = cfg.model.split("/")
        return { providerID, modelID }
      }
      return { providerID: "opencode", modelID: "x-preview-f-free" }
    },
    listWorkdirs: () => listWorkdirs(input.serverUrl.toString().replace(/\/$/, ""), serverAuth),
    listSessions: (directory) => bridge.sessionList?.(directory) ?? Promise.resolve([]),
  }

  const sessions = new SessionManager(
    bridge,
    SESSIONS_PATH(),
    fs,
    (sid) => approver.countBySession(sid), // 终审 I4a：/status 附带待审批数
    ops,
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

        // 附件路由：图片 → 多模态 file part（mime 取自 content_type）；
        // 文件 → 下载保存到项目目录 .qq-files/，prompt 告知路径由 opencode 工具读取
        const files: Array<{ mime: string; dataUrl: string }> = []
        const savedFiles: Array<{ filename: string; path: string; size: number }> = []
        for (const att of msg.attachments ?? []) {
          try {
            if (att.contentType.startsWith("image/")) {
              files.push({
                mime: att.contentType,
                dataUrl: await toImageDataUrl(att.url, fetch, att.contentType),
              })
            } else {
              const saved = await saveAttachment(
                att.url,
                att.filename ?? "file",
                path.join(input.directory, ".qq-files"),
              )
              savedFiles.push(saved)
            }
          } catch (e) {
            await replyTo(msg.openid, `附件下载失败（${att.filename ?? att.contentType}）：${String(e).slice(0, 80)}，仅处理文字部分`).catch(() => {})
          }
        }
        const mediaNote = [
          files.length ? `[图片 x${files.length}]` : "",
          savedFiles.length
            ? `[文件 x${savedFiles.length}: ${savedFiles.map((f) => `${f.filename}（${f.size} 字节）已保存到 ${f.path}，请用工具查看内容`).join("；")}]`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
        const promptText =
          (msg.quotedText ? `[引用消息] ${msg.quotedText}\n` : "") +
          (mediaNote ? `${mediaNote} ` : "") +
          msg.content
        if (!promptText.trim() && !files.length) {
          await replyTo(msg.openid, "收到空消息，未做处理。")
          return
        }
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
    resolveAction: (featureId) => cfg.menus?.find((m) => m.featureId === featureId)?.action,
    runCommand: async (openid, commandText) => {
      const reply = await sessions.dispatch(openid, commandText)
      await replyTo(openid, reply, "text", kb(() => buildReplyKeyboard(openid)))
      return reply
    },
    log: (level, message) => {
      void input.client.app.log({ body: { service: "opencode-qq", level, message } }).catch(() => {})
    },
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

  /** openid 反查：会话 ID → 绑定用户 */
  const openidOfSession = (sid: string): string | null => {
    for (const [openid, s] of Object.entries(sessions.snapshot())) if (s === sid) return openid
    return null
  }

  const detectFileType = (filename: string): number => {
    const ext = path.extname(filename).toLowerCase().replace(".", "")
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return 1
    if (ext === "mp4") return 2
    if (["silk", "mp3", "wav", "ogg"].includes(ext)) return 3
    return 4
  }

  return {
    tool: {
      qq_send_file: tool({
        description:
          "通过 QQ 把本地文件/图片/视频发送给当前对话的用户。当用户要求把某个文件、图片、截图或产出物发到 QQ 时调用",
        args: {
          path: tool.schema.string().describe("要发送的文件绝对路径"),
          caption: tool.schema.string().optional().describe("可选说明文字，将随文件一并发送"),
        },
        execute: async (args, ctx) => {
          const openid = openidOfSession(ctx.sessionID)
          if (!openid) return "当前会话未绑定 QQ 用户，无法通过 QQ 发送。"
          const data = await fs.promises.readFile(args.path)
          const filename = path.basename(args.path)
          const fileInfo = await api.uploadFileC2C(openid, {
            data,
            filename,
            fileType: detectFileType(filename),
          })
          const ref = passiveRefs.get(openid)
          const fresh = !!ref && Date.now() - ref.receivedAt < PASSIVE_WINDOW_MS
          await api.sendMedia(openid, fileInfo, fresh ? { msgId: ref!.msgId } : {})
          if (args.caption) await replyTo(openid, args.caption)
          return `已通过 QQ 发送 ${filename}（${data.length} 字节）`
        },
      }),
    },
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
