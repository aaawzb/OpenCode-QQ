import { MAX_REPLIES_PER_MSG_ID } from "../constants.js"
import { qqLog } from "../errors.js"
import type { SendOptions } from "../types.js"

const SEND_TIMEOUT_MS = 15000
/** 消息频控业务码：HTTP 状态可能不是 429，但语义等同限流 */
const RATE_ERR_CODE = 40034100
const SEQ_MAP_MAX = 500
const SEQ_EVICT_BATCH = 100

interface QQApiOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

interface ParsedBodyErr {
  code?: number
  message?: string
}

class SendHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly errCode?: number,
    readonly errMsg?: string,
  ) {
    super(`sendC2C failed: HTTP ${status} ${bodyText}`)
    this.name = "SendHttpError"
  }
}

function parseBodyErr(text: string): ParsedBodyErr {
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const raw = j.code ?? j.err_code
    return {
      ...(typeof raw === "number" ? { code: raw } : {}),
      ...(typeof j.message === "string" ? { message: j.message } : {}),
    }
  } catch {
    return {}
  }
}

/** 超时/中止单独标记：响应可能已送达，禁止降级重发（会撞平台去重） */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  return name === "TimeoutError" || name === "AbortError"
}

function failDetail(e: unknown): string {
  if (isTimeout(e)) return `请求超时(${SEND_TIMEOUT_MS}ms)，不降级不重发`
  if (e instanceof SendHttpError) {
    const parts = [`HTTP ${e.status}`]
    if (e.errCode !== undefined) parts.push(`err_code=${e.errCode}`)
    if (e.errMsg) parts.push(`message=${e.errMsg}`)
    parts.push(`body=${e.bodyText}`)
    return parts.join(" ")
  }
  return e instanceof Error ? e.message : String(e)
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
    if (this.seqCounters.size > SEQ_MAP_MAX) this.evictOldest()
    return seq
  }

  /** 按 Map 插入序淘汰最旧的一批键，避免全量 clear 打断幸存 msgId 的计数 */
  private evictOldest(): void {
    let evicted = 0
    for (const key of this.seqCounters.keys()) {
      this.seqCounters.delete(key)
      if (++evicted >= SEQ_EVICT_BATCH) break
    }
  }

  private backoff(retryAfter: string | null): Promise<void> {
    const seconds = Math.min(Number(retryAfter ?? "1") || 1, 30)
    return new Promise((r) => setTimeout(r, seconds * 1000))
  }

  private async postWithRetry(openid: string, body: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const token = await this.opts.getToken()
      // AbortSignal.timeout：单请求硬超时；超时异常向上抛且不可重试/降级
      const res = await this.fetchFn(`${this.opts.restBase}/v2/users/${openid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (res.status === 429 && attempt < 3) {
        await this.backoff(res.headers.get("Retry-After"))
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        const parsed = parseBodyErr(text)
        if (parsed.code === RATE_ERR_CODE && attempt < 3) {
          qqLog("api", "MSG_RATE", `HTTP ${res.status} ${text}`)
          await this.backoff(res.headers.get("Retry-After"))
          continue
        }
        throw new SendHttpError(res.status, text, parsed.code, parsed.message)
      }
      return
    }
  }

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const format = options.format ?? "text"
    // event_id 被动回复（响应按钮互动）：与 msg_id 互斥，无 msg_seq 概念
    if (options.eventId) {
      const body = format === "markdown" ? { msg_type: 2, markdown: { content }, event_id: options.eventId } : { msg_type: 0, content, event_id: options.eventId }
      try {
        await this.postWithRetry(openid, body)
      } catch (e) {
        qqLog("api", "MSG_SEND_FAIL", failDetail(e))
        throw e
      }
      return
    }
    let msgId = options.msgId
    let seqReserved: number | undefined
    if (msgId) {
      seqReserved = this.nextSeq(msgId)
      if (seqReserved === undefined) {
        qqLog("api", "SEQ_EXHAUSTED", msgId) // 被动额度用尽 → 主动消息
        msgId = undefined
      }
    }
    const makeBody = (fmt: "text" | "markdown"): Record<string, unknown> => {
      const body: Record<string, unknown> =
        fmt === "markdown" ? { msg_type: 2, markdown: { content } } : { msg_type: 0, content }
      if (msgId && seqReserved !== undefined) {
        body.msg_id = msgId
        body.msg_seq = seqReserved
      }
      if (options.keyboard !== undefined) body.keyboard = options.keyboard
      return body
    }
    try {
      await this.postWithRetry(openid, makeBody(format))
    } catch (e) {
      if (!isTimeout(e) && format === "markdown") {
        try {
          await this.postWithRetry(openid, makeBody("text")) // 降级复用同一 msg_seq
          return
        } catch (fallbackErr) {
          qqLog("api", "MSG_SEND_FAIL", `${failDetail(fallbackErr)} (markdown 降级后仍失败)`)
          throw fallbackErr
        }
      }
      qqLog("api", "MSG_SEND_FAIL", failDetail(e))
      throw e
    }
  }

  /** 互动事件应答：3 秒窗口内调用，2.5 秒硬超时不重试（同 id 仅可应答一次） */
  async putInteraction(interactionId: string, code: number): Promise<void> {
    const token = await this.opts.getToken()
    const res = await this.fetchFn(`${this.opts.restBase}/interactions/${interactionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) {
      const text = await res.text()
      qqLog("api", "KB_PUT_FAIL", `HTTP ${res.status} ${text.slice(0, 150)}`)
      throw new Error(`putInteraction failed: HTTP ${res.status}`)
    }
  }

  /** 查询全局自定义菜单（单聊窗口底部） */
  async getMenu(): Promise<unknown> {
    const token = await this.opts.getToken()
    const res = await this.fetchFn(`${this.opts.restBase}/v2/menu`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`getMenu failed: HTTP ${res.status}`)
    return await res.json()
  }

  /** 修改全局自定义菜单（覆盖式；5 QPM）。menu 结构见官方 /v2/menu 文档 */
  async setMenu(menu: unknown): Promise<void> {
    const token = await this.opts.getToken()
    const res = await this.fetchFn(`${this.opts.restBase}/v2/menu`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({ menu }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text()
      qqLog("api", "MENU_SET_FAIL", `HTTP ${res.status} ${text.slice(0, 150)}`)
      throw new Error(`setMenu failed: HTTP ${res.status} ${text.slice(0, 100)}`)
    }
  }
}
