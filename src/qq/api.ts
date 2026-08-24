import { MAX_REPLIES_PER_MSG_ID } from "../constants"
import type { SendOptions } from "../types"

interface QQApiOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

export class QQApi {
  private fetchFn: typeof fetch
  private queue: Promise<void> = Promise.resolve()
  private seqCounters = new Map<string, number>()

  constructor(private opts: QQApiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** 串行化所有发送，避免打爆频控 */
  sendC2C(openid: string, content: string, options: SendOptions = {}): Promise<void> {
    const task = this.queue.then(() => this.doSend(openid, content, options))
    this.queue = task.catch(() => {}) // 吞掉错误保持队列继续
    return task
  }

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const body: Record<string, unknown> = { msg_type: 0, content }
    if (options.msgId) {
      const used = this.seqCounters.get(options.msgId) ?? 0
      if (used >= MAX_REPLIES_PER_MSG_ID) {
        // 被动额度用尽 → 降级主动消息
      } else {
        body.msg_id = options.msgId
        body.msg_seq = used + 1
        this.seqCounters.set(options.msgId, used + 1)
        if (this.seqCounters.size > 500) this.pruneSeq()
      }
    }
    for (let attempt = 0; attempt <= 3; attempt++) {
      const token = await this.opts.getToken()
      const res = await this.fetchFn(`${this.opts.restBase}/v2/users/${openid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
      })
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1")
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000))
        continue
      }
      if (!res.ok) throw new Error(`sendC2C failed: HTTP ${res.status} ${await res.text()}`)
      return
    }
  }

  private pruneSeq(): void {
    // 简单防膨胀：超限时全量清理（旧 msg_seq 计数丢失只影响去重，不影响功能正确性）
    this.seqCounters.clear()
  }
}
