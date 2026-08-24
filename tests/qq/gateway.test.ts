import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer, type WebSocket as WsSocket } from "ws"
import { QQGateway } from "../../src/qq/gateway"

const INTENT = 1 << 25

interface Harness {
  server: WebSocketServer
  port: number
  _last?: WsSocket
  lastClient: () => WsSocket | undefined
}

async function startMockGateway(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => server.on("listening", r))
  const port = (server.address() as { port: number }).port
  const h: Harness = { server, port, lastClient: () => h._last }
  server.on("connection", (client) => {
    h._last = client
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }))
    client.on("message", (raw) => {
      const pkt = JSON.parse(raw.toString())
      if (pkt.op === 2) {
        client.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: { session_id: "SESS1", user: { id: "bot" } },
          }),
        )
      }
      if (pkt.op === 6) {
        client.send(JSON.stringify({ op: 0, s: 2, t: "RESUMED", d: {} }))
      }
      if (pkt.op === 1) client.send(JSON.stringify({ op: 11 }))
    })
  })
  return h
}

afterEach(() => vi.restoreAllMocks())

describe("QQGateway", () => {
  it("连接后 Identify 并收到 READY 与业务事件", async () => {
    const h = await startMockGateway()
    const gotReady = vi.fn()
    const gotMsg = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      connected: gotReady,
      message: gotMsg,
      disconnected: () => {},
    })
    gw.start()
    await vi.waitFor(() => expect(gotReady).toHaveBeenCalled())
    const client = h.lastClient()!
    client.send(
      JSON.stringify({
        op: 0,
        s: 2,
        t: "C2C_MESSAGE_CREATE",
        d: { openid: "U1", content: "hello", msg_id: "M1", timestamp: "2026-01-01" },
      }),
    )
    await vi.waitFor(() =>
      expect(gotMsg).toHaveBeenCalledWith(
        expect.objectContaining({ openid: "U1", content: "hello", msgId: "M1" }),
      ),
    )
    gw.stop()
    h.server.close()
  })

  it("断线后指数退避自动重连并恢复 Identify", async () => {
    const h = await startMockGateway()
    const connected = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      reconnectBaseMs: 10,
      connected,
      message: vi.fn(),
      disconnected: vi.fn(),
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1))
    h.lastClient()!.close()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    gw.stop()
    h.server.close()
  })

  it("退避窗口内 stop() 后不再重连", async () => {
    const h = await startMockGateway()
    const connected = vi.fn()
    const disconnected = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      reconnectBaseMs: 50,
      connected,
      disconnected,
      message: vi.fn(),
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1))
    h.lastClient()!.close()
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1))
    gw.stop()
    await new Promise((r) => setTimeout(r, 300))
    expect(connected).toHaveBeenCalledTimes(1)
    h.server.close()
  })
})
