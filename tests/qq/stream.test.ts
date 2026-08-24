import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamSender } from "../../src/qq/stream"

function okId(id: string) {
  return new Response(JSON.stringify({ id }), { status: 200 })
}

describe("StreamSender（延迟 begin：首次 update 即首片）", () => {
  let bodies: Array<Record<string, unknown>>
  let responses: Response[]
  let fetchFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    bodies = []
    responses = []
    fetchFn = vi.fn().mockImplementation(async (_url: string, init?: { body?: unknown }) => {
      // 实现发送 JSON 字符串，断言前解析（与 api.test.ts 惯例一致）
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responses.shift() ?? okId("sid")
    })
  })

  function makeSender(seq = 3) {
    return new StreamSender(
      {
        restBase: "https://api.bot.qq.com",
        getToken: () => Promise.resolve("TK"),
        fetchFn: fetchFn as typeof fetch,
      },
      { openid: "U", msgId: "MSG1", msgSeq: seq },
    )
  }

  it("首次 update 即首片（state=1,index=0），续片全量 replace 且前缀包含首片", async () => {
    responses.push(okId("SID-1"), okId("s"))
    const s = makeSender()
    await s.update("正在生成")
    await s.update("正在生成，第一段落")

    expect(bodies[0]).toMatchObject({
      input_mode: "replace", input_state: 1, index: 0,
      content_type: "markdown", content_raw: "正在生成",
      msg_id: "MSG1", msg_seq: 3,
    })
    expect(bodies[1]).toMatchObject({
      input_mode: "replace", input_state: 1, index: 1,
      stream_msg_id: "SID-1", msg_seq: 3,
      content_raw: "正在生成，第一段落",
    })
    // replace 前缀链：全量正文必须以上游已下发前缀开头
    expect(String(bodies[1].content_raw).startsWith(String(bodies[0].content_raw))).toBe(true)
  })

  it("finish 为收尾片（state=10），正文保持前缀链", async () => {
    responses.push(okId("S"), okId("s"))
    const s = makeSender()
    await s.update("abc")
    await s.finish("abcdef。完毕")
    expect(bodies[1]).toMatchObject({
      input_mode: "replace", input_state: 10, index: 1,
      stream_msg_id: "S", content_raw: "abcdef。完毕",
    })
    expect(String(bodies[1].content_raw).startsWith(String(bodies[0].content_raw))).toBe(true)
  })

  it("任何请求失败后置 failed 并停止再发", async () => {
    responses.push(new Response("", { status: 400 }))
    const s = makeSender()
    await s.update("x")
    expect(s.failed).toBe(true)
    await s.update("xy")
    await s.finish("xyz")
    expect(bodies).toHaveLength(1) // 失败后不再发
  })

  it("finish 后 update 是 no-op", async () => {
    responses.push(okId("S"), okId("s"))
    const s = makeSender()
    await s.update("a")
    await s.finish("ab")
    const n = bodies.length
    await s.update("abc")
    expect(bodies).toHaveLength(n)
  })

  it("从未 update 直接 finish：先补首片再收尾", async () => {
    responses.push(okId("S9"), okId("s"))
    const s = makeSender(2)
    await s.finish("完整回答")
    expect(bodies[0]).toMatchObject({
      input_state: 1, index: 0, content_raw: "完整回答", msg_id: "MSG1", msg_seq: 2,
    })
    expect(bodies[1]).toMatchObject({ input_state: 10, index: 1, stream_msg_id: "S9" })
  })

  it("未等待的连续调用按序串行发送（index 不乱序）", async () => {
    const resolvers: Array<(r: Response) => void> = []
    fetchFn.mockImplementation(async (_url: string, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Promise<Response>((resolve) => resolvers.push(resolve))
    })
    const s = makeSender()
    const p1 = s.update("a")
    const p2 = s.update("ab")
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies).toHaveLength(1) // 前一请求未放行前，后续不并发发出
    resolvers[0](okId("S1"))
    await p1
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[0]).toMatchObject({ input_state: 1, index: 0 })
    resolvers[1](okId("s"))
    await p2
    expect(bodies[1]).toMatchObject({ input_state: 1, index: 1, stream_msg_id: "S1" })
  })
})
