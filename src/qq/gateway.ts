import WebSocket from "ws"
import { GATEWAY_PATH } from "../constants.js"
import { qqLog } from "../errors.js"
import type { GatewayEvents, IncomingC2CMessage } from "../types.js"
import { extractQuotedText } from "../util/quote.js"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_SERVER_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/** close code 分级：intents 无权限 → 停止重连 */
const CLOSE_INTENTS_DENIED = new Set([4013, 4014])
/** close code 分级：机器人封禁/下架 → 停止重连 */
const CLOSE_BOT_BANNED = new Set([4914, 4915])
/** close code 分级：鉴权失败 → 清空会话后重连（4010 与 4001-4005） */
function isAuthFailClose(code: number): boolean {
  return code === 4010 || (code >= 4001 && code <= 4005)
}

interface Packet {
  op: number
  d?: Record<string, unknown>
  s?: number
  t?: string
  id?: string
}

export interface QQGatewayOptions extends GatewayEvents {
  getGatewayUrl: () => Promise<string>
  getToken: () => Promise<string>
  intents: number
  reconnectBaseMs?: number
  maxSeen?: number
}

export class QQGateway {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private resumeAttempted = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false
  private seenIds = new Set<string>()
  private seenOrder: string[] = []
  /** 最近一次收到 op11 心跳 ack 的时间戳；每次 HELLO 后重置为当前时间 */
  private lastAckAt = 0

  private isDuplicate(key: string): boolean {
    if (!key) return false
    if (this.seenIds.has(key)) return true
    this.seenIds.add(key)
    this.seenOrder.push(key)
    const cap = this.opts.maxSeen ?? 1000
    if (this.seenOrder.length > cap) {
      const oldest = this.seenOrder.shift()
      if (oldest !== undefined) this.seenIds.delete(oldest)
    }
    return false
  }

  constructor(private opts: QQGatewayOptions) {}

  start(): void {
    this.stopped = false
    this.connect().catch(() => this.scheduleReconnect())
  }

  stop(): void {
    this.stopped = true
    this.cleanup()
  }

  private cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      this.ws.removeAllListeners()
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
  }

  /** 清空会话状态，下次 HELLO 将走全新 Identify */
  private clearSession(): void {
    this.sessionId = null
    this.lastSeq = null
    this.resumeAttempted = false
  }

  /** 致命关闭（封禁/无权限）：停止重连并释放全部定时器与连接 */
  private halt(): void {
    this.stopped = true
    this.clearSession()
    this.cleanup()
  }

  /**
   * close code 分级处理：
   * - 4013/4014 intents 无权限 → 停止重连（重连也必然再被拒）
   * - 4914/4915 机器人封禁 → 停止重连
   * - 4010/4001-4005 鉴权失败 → 清空会话后按退避重连
   * - 其余 → 按原退避逻辑重连
   */
  private handleClose(code: number): void {
    if (CLOSE_INTENTS_DENIED.has(code)) {
      qqLog("gw", "GW_INTENTS_DENIED", code)
      this.halt()
      return
    }
    if (CLOSE_BOT_BANNED.has(code)) {
      qqLog("gw", "GW_BOT_BANNED", code)
      this.halt()
      return
    }
    if (isAuthFailClose(code)) {
      qqLog("gw", "GW_AUTH_FAIL", code)
      this.clearSession()
      this.scheduleReconnect()
      return
    }
    qqLog("gw", "GW_CLOSED", code)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.resumeAttempted) {
      this.resumeAttempted = false
      this.sessionId = null
      this.lastSeq = null
    }
    const base = this.opts.reconnectBaseMs ?? 1000
    const delay = Math.min(base * 2 ** this.reconnectAttempt, 60_000)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return
      this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private async connect(): Promise<void> {
    const url = await this.opts.getGatewayUrl()
    const ws = new WebSocket(url)
    this.ws = ws
    ws.on("message", (raw) => {
      // 终审 I3：非 JSON 帧直接 JSON.parse 会抛异常击穿 opencode 进程，守卫后丢弃
      let pkt: Packet
      try {
        pkt = JSON.parse(raw.toString()) as Packet
      } catch (e) {
        console.warn(`[opencode-qq] 丢弃非 JSON 网关帧: ${String(e).slice(0, 120)}`)
        return
      }
      this.handlePacket(pkt)
    })
    ws.on("close", (code) => {
      this.opts.disconnected()
      this.handleClose(code)
    })
    ws.on("error", () => ws.terminate())
  }

  private handlePacket(pkt: Packet): void {
    switch (pkt.op) {
      case OP_HELLO: {
        const interval = (pkt.d as { heartbeat_interval: number }).heartbeat_interval
        this.startHeartbeat(interval)
        if (this.sessionId !== null && this.lastSeq !== null) {
          this.resumeAttempted = true
          void this.sendResume().catch(() => this.ws?.terminate())
        } else {
          this.resumeAttempted = false
          void this.sendIdentify().catch(() => this.ws?.terminate())
        }
        break
      }
      case OP_HEARTBEAT_ACK:
        this.lastAckAt = Date.now()
        break
      case OP_SERVER_RECONNECT:
        // 服务端要求重连：保留会话（重连后可 Resume），主动 terminate 走 close → 重连
        qqLog("gw", "GW_SERVER_RECONNECT")
        this.ws?.terminate()
        break
      case OP_INVALID_SESSION:
        // Resume 被拒（Invalid Session）：清空会话，重连后走全新 Identify
        qqLog("gw", "GW_RESUME_REJECTED")
        this.clearSession()
        this.ws?.terminate()
        break
      case OP_DISPATCH: {
        this.lastSeq = pkt.s ?? this.lastSeq
        const d = (pkt.d ?? {}) as Record<string, unknown>
        if (this.isDuplicate(pkt.id ?? String(d.msg_id ?? ""))) return
        this.handleDispatch(pkt.t ?? "", d)
        break
      }
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.opts.intents, shard: [0, 1] },
      }),
    )
  }

  private async sendResume(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      }),
    )
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // 每条新连接重置 ack 基准：HELLO 后一个完整周期内未发心跳即超时判定不成立
    this.lastAckAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      // 超过约 2×heartbeat_interval 未收到任何 op11 ack，判定半开连接，强制重连
      if (Date.now() - this.lastAckAt > intervalMs * 2) {
        qqLog("gw", "GW_HEARTBEAT_TIMEOUT")
        this.ws?.terminate()
        return
      }
      this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }))
    }, intervalMs)
  }

  private handleDispatch(t: string, d: Record<string, unknown>): void {
    if (t === "READY") {
      // 防污染：session_id 缺失/为空时不得写入，否则重连会以空值尝试 Resume
      if (typeof d.session_id === "string" && d.session_id !== "") {
        this.sessionId = d.session_id
      }
      this.resumeAttempted = false
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "RESUMED") {
      this.resumeAttempted = false
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "INTERACTION_CREATE" && this.opts.interaction) {
      const data = (d.data ?? {}) as {
        type?: number
        resolved?: { button_data?: unknown; button_id?: unknown; feature_id?: unknown }
      }
      this.opts.interaction({
        id: String(d.id ?? ""),
        type: Number(data.type ?? d.type ?? 0),
        buttonData: String(data.resolved?.button_data ?? ""),
        buttonId: String(data.resolved?.button_id ?? ""),
        featureId: String(data.resolved?.feature_id ?? ""),
        userOpenid: String(d.user_openid ?? ""),
      })
      return
    }
    if (t === "C2C_MESSAGE_CREATE") {
      const rawAttachments = Array.isArray(d.attachments) ? d.attachments : []
      this.opts.message({
        // 事件结构随平台版本演进：openid 可能在顶层，也可能在 author.id / author.user_openid
        openid: String(d.openid ?? (d.author as { id?: string; user_openid?: string } | undefined)?.user_openid ?? (d.author as { id?: string } | undefined)?.id ?? ""),
        content: String(d.content ?? ""),
        msgId: String(d.msg_id ?? ""),
        timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
        attachments: rawAttachments
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          // 实测 content_type 带子类型（"image/jpeg"）或为 "file"；保留原值由上层路由
          .map((a) => ({
            contentType: String(a.content_type ?? a.contentType ?? "file"),
            url: String(a.url ?? ""),
            filename: a.filename === undefined ? undefined : String(a.filename),
          }))
          .filter((a) => a.url),
        quotedText: extractQuotedText(d),
      })
    }
  }
}

export function createGatewayUrlFetcher(
  restBase: string,
  getToken?: () => Promise<string>,
  fetchFn: typeof fetch = fetch,
) {
  return async (): Promise<string> => {
    const headers: Record<string, string> = {}
    if (getToken) {
      // /gateway 与其他 OpenAPI 一致需要鉴权，缺失时正式环境会 401/挂起
      headers.Authorization = `QQBot ${await getToken()}`
    }
    const res = await fetchFn(`${restBase}${GATEWAY_PATH}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`get gateway failed: HTTP ${res.status}`)
    return ((await res.json()) as { url: string }).url
  }
}
