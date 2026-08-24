import { MAX_REPLIES_PER_MSG_ID } from "../constants.js"
import type { SendOptions } from "../types.js"

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

  private nextSeq(msgId?: string): number | undefined {
    if (!msgId) return undefined
    const used = this.seqCounters.get(msgId) ?? 0
    if (used >= MAX_REPLIES_PER_MSG_ID) return undefined // 额度用尽 → 调用方降级主动消息
    const seq = used + 1
    this.seqCounters.set(msgId, seq)
    if (this.seqCounters.size > 500) this.seqCounters.clear()
    return seq
  }

  private async postWithRetry(openid: string, body: Record<string, unknown>): Promise<void> {
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

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const format = options.format ?? "text"
    let msgId = options.msgId
    let seqReserved: number | undefined
    if (msgId) {
      seqReserved = this.nextSeq(msgId)
      if (seqReserved === undefined) msgId = undefined // 被动额度用尽 → 主动消息
    }
    const makeBody = (fmt: "text" | "markdown"): Record<string, unknown> => {
      const body: Record<string, unknown> =
        fmt === "markdown" ? { msg_type: 2, markdown: { content } } : { msg_type: 0, content }
      if (msgId && seqReserved !== undefined) {
        body.msg_id = msgId
        body.msg_seq = seqReserved
      }
      return body
    }
    try {
      await this.postWithRetry(openid, makeBody(format))
    } catch (e) {
      if (format === "markdown") {
        await this.postWithRetry(openid, makeBody("text")) // 降级复用同一 msg_seq
        return
      }
      throw e
    }
  }
}
