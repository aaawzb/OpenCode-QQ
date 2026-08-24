import WebSocket from "ws"
import { GATEWAY_PATH } from "../constants.js"
import type { GatewayEvents, IncomingC2CMessage } from "../types.js"
import { extractQuotedText } from "../util/quote.js"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

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
    ws.on("close", () => {
      this.opts.disconnected()
      this.scheduleReconnect()
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
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }))
    }, intervalMs)
  }

  private handleDispatch(t: string, d: Record<string, unknown>): void {
    if (t === "READY") {
      this.sessionId = String(d.session_id)
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
    if (t === "C2C_MESSAGE_CREATE") {
      const rawAttachments = Array.isArray(d.attachments) ? d.attachments : []
      this.opts.message({
        openid: String(d.openid ?? ""),
        content: String(d.content ?? ""),
        msgId: String(d.msg_id ?? ""),
        timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
        attachments: rawAttachments
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .filter((a) => String(a.content_type ?? a.contentType ?? "") === "image" || String(a.url ?? "").match(/\.(png|jpe?g|gif|webp)/i))
          .map((a) => ({
            contentType: "image",
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
