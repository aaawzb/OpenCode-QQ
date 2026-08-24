import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamSender } from "../../src/qq/stream"

function okId(id: string) {
  return new Response(JSON.stringify({ id }), { status: 200 })
}

describe("StreamSender", () => {
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

  it("首片→续片→收尾的状态机报文正确", async () => {
    responses.push(okId("SID-1"), okId("s"), okId("s"))
    const s = new StreamSender({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await s.begin("U", "MSG1", 3, "正在生成")
    await s.update("正在生成，第一段落")
    await s.finish("正在生成，第一段落。完毕")

    expect(bodies[0]).toMatchObject({
      input_mode: "replace", input_state: 1, index: 0,
      content_type: "markdown", content_raw: "正在生成",
      msg_id: "MSG1", msg_seq: 3,
    })
    expect(bodies[1]).toMatchObject({
      input_state: 1, index: 1, stream_msg_id: "SID-1", msg_seq: 3,
      content_raw: "正在生成，第一段落",
    })
    expect(bodies[2]).toMatchObject({ input_state: 10, index: 2, stream_msg_id: "SID-1" })
  })

  it("update 按 replace 全量正文发送（前缀安全）", async () => {
    responses.push(okId("S"), okId("s"))
    const s = new StreamSender({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await s.begin("U", "M", 1, "abc")
    await s.update("abcdef")
    expect(bodies[1].content_raw).toBe("abcdef")
    expect(bodies[1].input_mode).toBe("replace")
  })

  it("任何请求失败后置 failed 并停止再发", async () => {
    responses.push(new Response("", { status: 400 }))
    const s = new StreamSender({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await s.begin("U", "M", 1, "x")
    expect(s.failed).toBe(true)
    await s.update("xy")
    await s.finish("xyz")
    expect(bodies).toHaveLength(1) // 失败后不再发
  })

  it("finish 后 update 是 no-op", async () => {
    responses.push(okId("S"), okId("s"))
    const s = new StreamSender({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await s.begin("U", "M", 1, "a")
    await s.finish("ab")
    const n = bodies.length
    await s.update("abc")
    expect(bodies).toHaveLength(n)
  })
})
