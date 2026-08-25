export interface IncomingC2CMessage {
  openid: string
  content: string
  msgId: string
  timestamp: number
  attachments?: Array<{ contentType: string; url: string; filename?: string }>
  quotedText?: string
}

export interface SendOptions {
  /** 引用的被动回复消息 id；不带则为主动消息。与 eventId 互斥 */
  msgId?: string
  /** 响应互动事件的被动回复（INTERACTION_CREATE 的 d.id），与 msgId 互斥 */
  eventId?: string
  /** 回复格式；默认 text。markdown 发送失败自动降级 text 重试一次 */
  format?: "text" | "markdown"
  /** 可选：随消息携带的 keyboard 结构（消息互动按钮） */
  keyboard?: unknown
}

export interface InteractionEvent {
  id: string
  type: number
  buttonData: string
  buttonId: string
  userOpenid: string
}

export interface GatewayEvents {
  message(msg: IncomingC2CMessage): void
  connected(): void
  disconnected(): void
  /** 可选：INTERACTION_CREATE 互动事件（按钮点击等） */
  interaction?(evt: InteractionEvent): void
}
