interface StreamSenderOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

export class StreamSender {
  private streamMsgId: string | null = null
  private index = 0
  private finished = false
  failed = false
  // begin 缓存会话级参数，供续片使用
  private openidCache: string | null = null
  private msgSeqCache: number | null = null

  constructor(private opts: StreamSenderOptions) {}

  private async post(openid: string, body: Record<string, unknown>): Promise<boolean> {
    if (this.failed || this.finished) return false
    try {
      const token = await this.opts.getToken()
      const res = await (this.opts.fetchFn ?? fetch)(
        `${this.opts.restBase}/v2/users/${openid}/stream_messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        this.failed = true // 含 40007 前缀冲突 / 50002 限频 / 其他
        return false
      }
      const data = (await res.json()) as { id?: string }
      if (!this.streamMsgId && data.id) this.streamMsgId = data.id
      this.index++
      return true
    } catch {
      this.failed = true
      return false
    }
  }

  /** 首片：input_state=1, index=0 */
  async begin(openid: string, msgId: string, msgSeq: number, initialText: string): Promise<void> {
    this.openidCache = openid
    this.msgSeqCache = msgSeq
    await this.post(openid, {
      input_mode: "replace",
      input_state: 1,
      index: 0,
      content_type: "markdown",
      content_raw: initialText,
      msg_id: msgId,
      msg_seq: msgSeq,
    })
  }

  /** 续片：全量正文 replace */
  async update(fullText: string): Promise<void> {
    if (this.failed || this.finished || !this.openidCache || this.msgSeqCache === null) return
    await this.post(this.openidCache, {
      input_mode: "replace",
      input_state: 1,
      index: this.index,
      content_type: "markdown",
      content_raw: fullText,
      ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      msg_seq: this.msgSeqCache,
    })
  }

  /** 收尾片 */
  async finish(fullText: string): Promise<void> {
    if (this.failed || this.finished || !this.openidCache || this.msgSeqCache === null) return
    await this.post(this.openidCache, {
      input_mode: "replace",
      input_state: 10,
      index: this.index,
      content_type: "markdown",
      content_raw: fullText,
      ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      msg_seq: this.msgSeqCache,
    })
    this.finished = true
  }
}
