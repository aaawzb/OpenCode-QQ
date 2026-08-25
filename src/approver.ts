export interface PendingApproval {
  permissionId: string
  sessionId: string
  summary: string
}

export interface ParsedApprovalReply {
  seq: number
  reply: "once" | "reject"
}

export class Approver {
  private pending = new Map<number, PendingApproval & { timer: ReturnType<typeof setTimeout> }>()
  private nextSeq = 1

  constructor(private timeoutMs: number) {}

  register(sessionId: string, permissionId: string, summary: string): number {
    const seq = this.nextSeq++
    const timer = setTimeout(() => this.pending.delete(seq), this.timeoutMs)
    this.pending.set(seq, { permissionId, sessionId, summary, timer })
    return seq
  }

  render(seq: number): string {
    const item = this.pending.get(seq)
    return [
      `「权限请求 #${seq}」 ${item?.summary ?? ""}`,
      `回复“同意 ${seq}”批准本次，回复“拒绝 ${seq}”拒绝。`,
    ].join("\n")
  }

  parseReply(text: string): ParsedApprovalReply | null {
    const m = /^(同意|拒绝)\s*(\d+)$/.exec(text.trim())
    if (!m) return null
    return { reply: m[1] === "同意" ? "once" : "reject", seq: Number(m[2]) }
  }

  confirm(seq: number): PendingApproval | undefined {
    const item = this.pending.get(seq)
    if (!item) return undefined
    clearTimeout(item.timer)
    this.pending.delete(seq)
    const { timer: _t, ...rest } = item
    return rest
  }

  clearSession(sessionId: string): void {
    for (const [seq, item] of this.pending) {
      if (item.sessionId === sessionId) {
        clearTimeout(item.timer)
        this.pending.delete(seq)
      }
    }
  }

  /** 终审 I4a：某会话当前待审批数量（供 /status 展示） */
  countBySession(sessionId: string): number {
    let n = 0
    for (const item of this.pending.values()) if (item.sessionId === sessionId) n++
    return n
  }
}
