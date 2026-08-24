import { qqLog } from "../errors.js"

interface StreamSenderOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

/** 流式接口成功响应体 */
interface StreamRespData {
  id?: string
  ext_info?: { remain_msg_len?: unknown }
}

/** 从错误响应 body 提取 err_code；body 非 JSON 时返回 null */
function parseErrCode(raw: string): number | null {
  try {
    const code = (JSON.parse(raw) as { err_code?: unknown }).err_code
    return typeof code === "number" ? code : null
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 会话级被动引用：begin 首片必须携带 */
export interface StreamSessionRef {
  openid: string
  msgId: string
  msgSeq: number
}

/**
 * stream_messages 打字机发送器。
 *
 * 延迟 begin：首次 update() 即为首片（input_state=1,index=0，content_raw=首批文本），
 * 其后 update 为全量 replace 续片——正文天然以首片为前缀，保证 replace 前缀链一致
 * （协议要求续片全量正文以上游已下发前缀开头，否则 40007）。
 * 内部串行队列保证报文按序发出、index 有序，允许调用方 fire-and-forget。
 */
export class StreamSender {
  private streamMsgId: string | null = null
  private index = 0
  private begun = false
  private finished = false
  private finalized = false // 收尾片已实际发出；此后丢弃排队中的续片
  failed = false
  private _delivered = false
  /** 最近一次已知的 ext_info.remain_msg_len；响应从未携带时为 null */
  lastRemainLen: number | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private opts: StreamSenderOptions,
    private ref: StreamSessionRef,
  ) {}

  /** 任一分片 post 成功即为 true；调用方据此判断流式是否真正送达过内容 */
  get delivered(): boolean {
    return this._delivered
  }

  /** 推送当前累计全文；首次调用自动作为首片 */
  update(fullText: string): Promise<void> {
    if (this.failed || this.finished || !fullText) return Promise.resolve()
    if (!this.begun) {
      this.begun = true
      return this.enqueue(() => ({
        input_mode: "replace",
        input_state: 1,
        index: 0,
        content_type: "markdown",
        content_raw: fullText,
        msg_id: this.ref.msgId,
        msg_seq: this.ref.msgSeq,
      }))
    }
    return this.enqueue(() => this.pieceBody(1, fullText))
  }

  /** 收尾片；从未发过片时先补首片再收尾 */
  finish(fullText: string): Promise<void> {
    if (this.failed || this.finished || !fullText) return Promise.resolve()
    if (!this.begun) {
      const first = this.update(fullText)
      this.finished = true
      return first.then(() => {
        if (this.failed) return
        return this.enqueue(() => this.pieceBody(10, fullText))
      })
    }
    this.finished = true
    return this.enqueue(() => this.pieceBody(10, fullText))
  }

  /** 续片/收尾通用报文；index 与 stream_msg_id 在实际发送时取最新值 */
  private pieceBody(inputState: number, fullText: string): Record<string, unknown> {
    return {
      input_mode: "replace",
      input_state: inputState,
      index: this.index,
      content_type: "markdown",
      content_raw: fullText,
      msg_id: this.ref.msgId, // 官方示例：续片/收尾同样携带被动引用
      ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      msg_seq: this.ref.msgSeq,
    }
  }

  /** FIFO 串行队列：body 延迟到执行时构造，确保拿到最新 index/stream_msg_id */
  private enqueue(makeBody: () => Record<string, unknown>): Promise<void> {
    const task = this.queue.then(async () => {
      await this.post(makeBody())
    })
    this.queue = task.catch(() => {})
    return task
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    // 排队期间被置败则放弃；收尾片发出后仅允许收尾片本身通过（丢弃排队中的续片）
    if (body.input_state === 10) this.finalized = true
    if (this.failed || (this.finalized && body.input_state !== 10)) return
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        const token = await this.opts.getToken()
        res = await (this.opts.fetchFn ?? fetch)(
          `${this.opts.restBase}/v2/users/${this.ref.openid}/stream_messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
            body: JSON.stringify(body),
          },
        )
      } catch {
        this.failed = true
        return
      }
      if (!res.ok) {
        const raw = await res.text().catch(() => "")
        const code = parseErrCode(raw)
        if (code === 50002 && attempt === 0) {
          qqLog("stream", "STREAM_RATE", raw || `HTTP ${res.status}`)
          await sleep(1000)
          continue // 限频仅退避重试一次
        }
        if (code === 50001) qqLog("stream", "STREAM_SERVER", raw)
        else if (code === 40007) qqLog("stream", "STREAM_PREFIX", raw)
        this.failed = true
        return
      }
      let data: StreamRespData
      try {
        data = (await res.json()) as StreamRespData
      } catch {
        this.failed = true
        return
      }
      if (!this.streamMsgId && !data.id) {
        // 首片拿不到 stream_msg_id 则整条流无法续传，按发送失败处理
        qqLog("stream", "STREAM_BEGIN_FAIL", "HTTP ok 但响应缺少 id")
        this.failed = true
        return
      }
      if (!this.streamMsgId && data.id) this.streamMsgId = data.id
      this._delivered = true
      this.index++
      const remain = data.ext_info?.remain_msg_len
      if (typeof remain === "number") this.lastRemainLen = remain
      if (typeof remain === "number" && remain < 100 && !this.finished) {
        // 余量告急：立即以同正文收尾，避免后续分片被平台截断；先置 finished 防递归
        this.finished = true
        await this.post(this.pieceBody(10, String(body.content_raw)))
      }
      return
    }
  }
}
