/**
 * assistant 流式文本缓冲（终审 C1）。
 *
 * 真实 SDK 事件类型（node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts）：
 * - EventMessagePartUpdated.properties = { part: Part; delta?: string }
 *   part 是全量快照，专用增量字段是 delta；
 * - TextPart 自带 id/sessionID/messageID，但不含角色字段；
 * - 角色在 Message 上（EventMessageUpdated.properties.info.role）。
 */
export interface OcEventLike {
  type: string
  properties: Record<string, unknown>
}

interface TrackedMessage {
  sessionId: string
  role: string
}

/** 角色映射上限，防长会话内存无界增长 */
const MAX_TRACKED_MESSAGES = 500

export class AssistantTextBuffer {
  /** messageID → 角色信息（来自 message.updated） */
  private roles = new Map<string, TrackedMessage>()
  /** sessionID → (partID → 该 part 文本)；Map 保序，拼接即出现顺序 */
  private parts = new Map<string, Map<string, string>>()

  constructor(private readonly isOurSession: (sessionId: string) => boolean) {}

  handle(evt: OcEventLike): void {
    if (evt.type === "message.updated") this.trackRole(evt.properties ?? {})
    else if (evt.type === "message.part.updated") this.applyPart(evt.properties ?? {})
  }

  private trackRole(props: Record<string, unknown>): void {
    const info = props.info as { id?: unknown; sessionID?: unknown; role?: unknown } | undefined
    if (!info || typeof info.id !== "string" || typeof info.role !== "string") return
    if (!this.roles.has(info.id) && this.roles.size >= MAX_TRACKED_MESSAGES) {
      const oldest = this.roles.keys().next().value
      if (oldest !== undefined) this.roles.delete(oldest)
    }
    this.roles.set(info.id, { sessionId: String(info.sessionID ?? ""), role: info.role })
  }

  private applyPart(props: Record<string, unknown>): void {
    const part = props.part as
      | { id?: unknown; sessionID?: unknown; messageID?: unknown; type?: unknown; text?: unknown }
      | undefined
    if (!part || part.type !== "text" || typeof part.id !== "string") return
    // SDK 里 properties 无顶层 sessionID，会话 ID 在 part.sessionID；旧形状兜底读 properties
    const sid =
      typeof part.sessionID === "string" && part.sessionID ? part.sessionID : String(props.sessionID ?? "")
    const messageId = typeof part.messageID === "string" ? part.messageID : ""
    if (!sid || !messageId || !this.isOurSession(sid)) return
    // 只累计 assistant 消息文本：part 无角色字段，用 message.updated 建立的
    // messageID → role 映射过滤；跟踪不到的消息一律丢弃，避免用户提问原文混入。
    if (this.roles.get(messageId)?.role !== "assistant") return

    const bucket = this.parts.get(sid) ?? new Map<string, string>()
    if (typeof props.delta === "string") {
      // delta 语义：对同一 part.id 做增量累计
      bucket.set(part.id, (bucket.get(part.id) ?? "") + props.delta)
    } else {
      // 快照语义（delta 缺失回退）：按 part.id 整体替换
      bucket.set(part.id, typeof part.text === "string" ? part.text : "")
    }
    this.parts.set(sid, bucket)
  }

  text(sessionId: string): string | null {
    const bucket = this.parts.get(sessionId)
    if (!bucket || bucket.size === 0) return null
    let out = ""
    for (const t of bucket.values()) out += t
    return out
  }

  clear(sessionId: string): void {
    this.parts.delete(sessionId)
  }

  clearAll(): void {
    this.parts.clear()
  }
}
