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

async function firstClient(h: Harness): Promise<WsSocket> {
  await vi.waitFor(() => {
    if (!h.lastClient()) throw new Error("no client yet")
  })
  return h.lastClient()!
}

interface LogSpy {
  text: () => string
}

function spyLogs(): LogSpy {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  return {
    text: () => [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(" ")).join("\n"),
  }
}

interface MultiConnHarness {
  port: number
  server: WebSocketServer
  clients: WsSocket[]
  sentOps: number[][]
}

/** 多连接 mock 网关：HELLO(60s 心跳) → op2 回 READY，op6 默认回 RESUMED；记录每条连接收到的 op 序列 */
async function startMultiConnGateway(opts?: { onResume?: (client: WsSocket) => void; noAck?: boolean; interval?: number }): Promise<MultiConnHarness> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => server.on("listening", r))
  const port = (server.address() as { port: number }).port
  const h: MultiConnHarness = { port, server, clients: [], sentOps: [] }
  server.on("connection", (client) => {
    h.clients.push(client)
    const ops: number[] = []
    h.sentOps.push(ops)
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: opts?.interval ?? 60000 } }))
    client.on("message", (raw) => {
      const pkt = JSON.parse(raw.toString())
      ops.push(pkt.op)
      if (pkt.op === 2) {
        client.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            // 故意每次连接给不同 session_id，便于区分
            d: { session_id: `SESS-${h.sentOps.length}`, user: { id: "bot" } },
          }),
        )
      }
      if (pkt.op === 6) {
        if (opts?.onResume) opts.onResume(client)
        else client.send(JSON.stringify({ op: 0, s: 2, t: "RESUMED", d: {} }))
      }
      if (pkt.op === 1 && !opts?.noAck) client.send(JSON.stringify({ op: 11 }))
    })
  })
  return h
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    const client = await firstClient(h)
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
    ;(await firstClient(h)).close()
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

  it("非 JSON 畸形帧被丢弃并告警，后续正常帧继续处理（I3）", async () => {
    const h = await startMockGateway()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
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
    client.send("this is not json{{{") // 畸形帧：不得击穿进程
    client.send("")

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(gotMsg).not.toHaveBeenCalled()

    // 后续正常帧仍能处理
    client.send(
      JSON.stringify({
        op: 0,
        s: 3,
        t: "C2C_MESSAGE_CREATE",
        d: { openid: "U9", content: "after garbage", msg_id: "M9", timestamp: "2026-01-01" },
      }),
    )
    await vi.waitFor(() =>
      expect(gotMsg).toHaveBeenCalledWith(expect.objectContaining({ openid: "U9", content: "after garbage" })),
    )
    gw.stop()
    h.server.close()
  })

  it("映射 attachments 与引用文本到 message 回调", async () => {
    const h = await startMockGateway()
    const gotMsg = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      connected: vi.fn(),
      message: gotMsg,
      disconnected: vi.fn(),
    })
    gw.start()
    const client = await firstClient(h)
    client.send(JSON.stringify({
      op: 0, s: 9, t: "C2C_MESSAGE_CREATE",
      id: "EVT-ATT-1",
      d: {
        openid: "U2", content: "看看这个", msg_id: "M2", timestamp: "2026-01-01",
        attachments: [{ content_type: "image", url: "https://cdn/x.png" }],
        message_type: 103,
        msg_elements: [{ text_element: { content: "原图内容" } }],
      },
    }))
    await vi.waitFor(() => expect(gotMsg).toHaveBeenCalled())
    const msg = gotMsg.mock.calls[0][0]
    expect(msg.attachments).toEqual([{ contentType: "image", url: "https://cdn/x.png", filename: undefined }])
    expect(msg.quotedText).toBe("原图内容")
    gw.stop()
    h.server.close()
  })

  it("op9 Invalid Session：清空会话、告警 GW004 并重连走全新 Identify", async () => {
    const h = await startMultiConnGateway({
      onResume: (client) => client.send(JSON.stringify({ op: 9, d: false })),
    })
    const logs = spyLogs()
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
    h.clients[0].close() // 触发一次断线，下条连接应尝试 Resume
    // conn2 Resume 被 op9 拒绝（无 RESUMED 事件），conn3 全新 Identify 成功 → 共 2 次 connected
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(h.sentOps[1]).toContain(6) // 第二次连接走了 Resume
    expect(logs.text()).toContain("GW004") // 收到 op9 后告警
    expect(h.sentOps[2]).toContain(2) // op9 清空会话后，第三次连接为全新 Identify
    expect(h.sentOps[2]).not.toContain(6)
    gw.stop()
    h.server.close()
  })

  it("op7 Reconnect：告警 GW005 并主动重连", async () => {
    const h = await startMultiConnGateway()
    const logs = spyLogs()
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
    ;(await firstClient({ server: h.server, port: h.port, lastClient: () => h.clients.at(-1) })).send(
      JSON.stringify({ op: 7 }),
    )
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(logs.text()).toContain("GW005")
    gw.stop()
    h.server.close()
  })

  it("close 4013/4014：告警 GW006 并停止重连", async () => {
    for (const code of [4013, 4014]) {
      const h = await startMultiConnGateway()
      const logs = spyLogs()
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
      h.clients[0].close(code, "intents denied")
      await vi.waitFor(() => expect(logs.text()).toContain("GW006"))
      await sleep(300)
      expect(connected).toHaveBeenCalledTimes(1) // 停止重连
      gw.stop()
      h.server.close()
    }
  })

  it("close 4914/4915：告警 GW007（封禁）并停止重连", async () => {
    const h = await startMultiConnGateway()
    const logs = spyLogs()
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
    h.clients[0].close(4915, "banned")
    await vi.waitFor(() => expect(logs.text()).toContain("GW007"))
    await sleep(300)
    expect(connected).toHaveBeenCalledTimes(1)
    gw.stop()
    h.server.close()
  })

  it("close 4010：告警 GW008、清空会话并以全新 Identify 重连", async () => {
    const h = await startMultiConnGateway()
    const logs = spyLogs()
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
    h.clients[0].close(4010, "auth fail")
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(logs.text()).toContain("GW008")
    expect(h.sentOps[1]).toContain(2) // 会话已清空 → 全新 Identify
    expect(h.sentOps[1]).not.toContain(6)
    gw.stop()
    h.server.close()
  })

  it("其他 close code：告警 GW003 并按退避重连", async () => {
    const h = await startMultiConnGateway()
    const logs = spyLogs()
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
    h.clients[0].close(4321, "unknown")
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(logs.text()).toContain("GW003")
    gw.stop()
    h.server.close()
  })

  it("心跳超时：持续无 op11 ack 时判定半开连接并强制重连（GW009）", async () => {
    const h = await startMultiConnGateway({ noAck: true, interval: 15 })
    const logs = spyLogs()
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
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 }) // 第一条连接因心跳超时被 terminate 后重连
    expect(logs.text()).toContain("GW009")
    gw.stop()
    h.server.close()
  })

  it("心跳正常收到 op11 时不会误判超时", async () => {
    const h = await startMultiConnGateway({ interval: 25 })
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
    await sleep(300)
    expect(connected).toHaveBeenCalledTimes(1) // 期间未被误杀
    const beats = h.sentOps[0].filter((op) => op === 1).length
    expect(beats).toBeGreaterThanOrEqual(3) // 心跳确实发了多拍且都收到 ack
    gw.stop()
    h.server.close()
  })

  it("READY 缺失/空 session_id 时不污染会话，重连仍走全新 Identify", async () => {
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.on("listening", r))
    const port = (server.address() as { port: number }).port
    const clients: WsSocket[] = []
    const sentOps: number[][] = []
    server.on("connection", (client) => {
      clients.push(client)
      const ops: number[] = []
      sentOps.push(ops)
      client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }))
      client.on("message", (raw) => {
        const pkt = JSON.parse(raw.toString())
        ops.push(pkt.op)
        if (pkt.op === 2) {
          // 空 session_id：不得被写入会话状态
          client.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "", user: { id: "bot" } } }))
        }
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
    expect(sentOps[1]).toContain(2) // 空 session_id 未写入 → 重连走 Identify 而非 Resume
    expect(sentOps[1]).not.toContain(6)
    gw.stop()
    server.close()
  })

  it("INTERACTION_CREATE 路由到 interaction 回调", async () => {
    const h = await startMockGateway()
    const got = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      connected: vi.fn(),
      disconnected: vi.fn(),
      message: vi.fn(),
      interaction: got,
    })
    gw.start()
    const client = await firstClient(h)
    client.send(
      JSON.stringify({
        op: 0,
        s: 7,
        t: "INTERACTION_CREATE",
        id: "INT-EVT-1",
        d: {
          id: "IID-1",
          type: 11,
          scene: "c2c",
          user_openid: "U9",
          data: { type: 11, resolved: { button_data: "approve:3", button_id: "b1" } },
        },
      }),
    )
    await vi.waitFor(() => expect(got).toHaveBeenCalled())
    expect(got.mock.calls[0][0]).toEqual({
      id: "IID-1",
      type: 11,
      buttonData: "approve:3",
      buttonId: "b1",
      userOpenid: "U9",
    })
    gw.stop()
    h.server.close()
  })
})
