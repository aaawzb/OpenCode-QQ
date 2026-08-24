interface StreamSenderOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

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
  failed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private opts: StreamSenderOptions,
    private ref: StreamSessionRef,
  ) {}

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
    if (this.failed) return // 排队期间被置败（如重入作废）则放弃执行
    try {
      const token = await this.opts.getToken()
      const res = await (this.opts.fetchFn ?? fetch)(
        `${this.opts.restBase}/v2/users/${this.ref.openid}/stream_messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        this.failed = true // 含 40007 前缀冲突 / 50002 限频 / 其他
        return
      }
      const data = (await res.json()) as { id?: string }
      if (!this.streamMsgId && data.id) this.streamMsgId = data.id
      this.index++
    } catch {
      this.failed = true
    }
  }
}
