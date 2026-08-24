export interface IncomingC2CMessage {
  openid: string
  content: string
  msgId: string
  timestamp: number
}

export interface SendOptions {
  /** 引用的被动回复消息 id；不带则为主动消息 */
  msgId?: string
}

export interface GatewayEvents {
  message(msg: IncomingC2CMessage): void
  connected(): void
  disconnected(): void
}
