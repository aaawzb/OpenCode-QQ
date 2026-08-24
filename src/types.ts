export interface IncomingC2CMessage {
  openid: string
  content: string
  msgId: string
  timestamp: number
  attachments?: Array<{ contentType: string; url: string; filename?: string }>
  quotedText?: string
}

export interface SendOptions {
  /** 引用的被动回复消息 id；不带则为主动消息 */
  msgId?: string
  /** 回复格式；默认 text。markdown 发送失败自动降级 text 重试一次 */
  format?: "text" | "markdown"
}

export interface GatewayEvents {
  message(msg: IncomingC2CMessage): void
  connected(): void
  disconnected(): void
}
