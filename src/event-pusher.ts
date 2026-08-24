import { Throttler } from "./util/throttle.js"

export interface EventPusherDeps {
  isOurSession(sessionId: string): boolean
  openidOfSession(sessionId: string): string | null
  send(openid: string, text: string): Promise<void>
  /** 由 index.ts 提供：把 opencode event hook 交进来 */
  subscribe(handler: (evt: { type: string; properties: Record<string, unknown> }) => void): void
  toolProgress: boolean
  /** 测试可注入极小间隔；默认 60s */
  toolProgressIntervalMs?: number
  /** 终审 I4b：session.idle 推送附带最后回复摘要（尾部 200 字符） */
  lastAssistantText?: (sessionId: string) => string | null
}

const TOOL_PROGRESS_INTERVAL_MS = 60_000

const ERROR_SUMMARY_MAX = 300

/**
 * 终审 I2：props.error 是结构化对象（如 {name:"UnknownError", data:{message}}），
 * 直接 String() 会得到 "[object Object]"。按 data.message → name → String 链提取。
 */
function summarizeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; data?: { message?: unknown } }
    const message = e.data && typeof e.data === "object" ? e.data.message : undefined
    if (typeof message === "string" && message) return message.slice(0, ERROR_SUMMARY_MAX)
    if (typeof e.name === "string" && e.name) return e.name.slice(0, ERROR_SUMMARY_MAX)
  }
  return String(error ?? "未知错误").slice(0, ERROR_SUMMARY_MAX)
}

export class EventPusher {
  private throttler: Throttler

  /** 断线补发队列 */
  private offlineQueue: Array<{ openid: string; text: string }> = []
  private online = true

  constructor(private deps: EventPusherDeps) {
    this.throttler = new Throttler(deps.toolProgressIntervalMs ?? TOOL_PROGRESS_INTERVAL_MS, (key, lines) => {
      const openid = key
      void this.deps
        .send(openid, `🛠 工具进度:\n${lines.map((l) => `- ${l}`).join("\n")}`)
        .catch(() => {})
    })
    deps.subscribe((evt) => this.handle(evt))
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) {
      for (const item of this.offlineQueue.splice(0)) {
        this.deps.send(item.openid, item.text).catch(() => {})
      }
    }
  }

  private deliver(openid: string, text: string): void {
    if (!this.online) {
      this.offlineQueue.push({ openid, text })
      return
    }
    this.deps.send(openid, text).catch(() => {})
  }

  private handle(evt: { type: string; properties: Record<string, unknown> }): void {
    const props = evt.properties ?? {}
    const sessionId = String(props.sessionID ?? props.sessionId ?? "")
    if (!sessionId || !this.deps.isOurSession(sessionId)) return
    const openid = this.deps.openidOfSession(sessionId)
    if (!openid) return

    switch (evt.type) {
      case "session.idle": {
        const tail = this.deps.lastAssistantText?.(sessionId)
        this.deliver(openid, tail ? `✅ 任务完成。\n摘要: ${tail.slice(-200)}` : "✅ 任务完成。")
        break
      }
      case "session.error": {
        const err = summarizeError(props.error)
        this.deliver(openid, `❌ 出错: ${err}`)
        break
      }
      case "tool.execute.after":
        if (this.deps.toolProgress) {
          const tool = String(props.tool ?? "tool")
          const title = String(props.title ?? props.description ?? "").slice(0, 80)
          this.throttler.push(openid, `${tool}: ${title}`)
        }
        break
    }
  }

  dispose(): void {
    this.throttler.dispose()
  }
}
