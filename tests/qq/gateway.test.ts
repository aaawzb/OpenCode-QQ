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

  it("Resume 被拒（服务端直接断开）后回落全新 Identify 而非循环 Resume", async () => {
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.on("listening", r))
    const port = (server.address() as { port: number }).port
    const clients: WsSocket[] = []
    const sentOps: number[][] = []
    server.on("connection", (client) => {
      clients.push(client)
      const ops: number[] = []
      sentOps.push(ops)
      client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }))
      client.on("message", (raw) => {
        const pkt = JSON.parse(raw.toString())
        ops.push(pkt.op)
        if (pkt.op === 2) {
          client.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: { session_id: `SESS-${sentOps.length}`, user: { id: "bot" } },
            }),
          )
        }
        if (pkt.op === 6) client.close()
      })
    })
    const connected = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      reconnectBaseMs: 10,
      connected,
      message: vi.fn(),
      disconnected: vi.fn(),
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1))
    clients[0].close()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(sentOps[1]).toContain(6)
    expect(sentOps[2]).toContain(2)
    expect(sentOps[2]).not.toContain(6)
    gw.stop()
    server.close()
  })

  it("getToken 失败被兜底，不产生 unhandled rejection 且能恢复连接", async () => {
    const h = await startMockGateway()
    let calls = 0
    const connected = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => (++calls === 1 ? Promise.reject(new Error("token boom")) : Promise.resolve("TK")),
      intents: INTENT,
      reconnectBaseMs: 10,
      connected,
      message: vi.fn(),
      disconnected: vi.fn(),
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1), { timeout: 5000 })
    gw.stop()
    h.server.close()
  })

  it("同一事件的重复推送只回调一次", async () => {
    const h = await startMockGateway()
    const connected = vi.fn()
    const gotMsg = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      connected,
      disconnected: vi.fn(),
      message: gotMsg,
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalled())
    const client = h.lastClient()!
    const dup = {
      op: 0,
      s: 5,
      t: "C2C_MESSAGE_CREATE",
      id: "EVT-DUP-1",
      d: { openid: "U1", content: "once", msg_id: "M1", timestamp: "2026-01-01" },
    }
    client.send(JSON.stringify(dup))
    await vi.waitFor(() => expect(gotMsg).toHaveBeenCalledTimes(1))
    client.send(JSON.stringify({ ...dup, s: 6 })) // 同 id 重推
    await new Promise((r) => setTimeout(r, 100))
    expect(gotMsg).toHaveBeenCalledTimes(1) // 未增加
    gw.stop()
    h.server.close()
  })
})
