import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { StreamSender } from "../../src/qq/stream"

function okId(id: string) {
  return new Response(JSON.stringify({ id }), { status: 200 })
}

function errRes(errCode: number, status = 400) {
  return new Response(JSON.stringify({ err_code: errCode, message: "boom" }), { status })
}

function okRemain(id: string, remain?: number) {
  const data: Record<string, unknown> = { id }
  if (remain !== undefined) data.ext_info = { remain_msg_len: remain }
  return new Response(JSON.stringify(data), { status: 200 })
}

/** 独立测试台架：不干扰原有 describe 的闭包状态 */
function makeHarness() {
  const bodies: Array<Record<string, unknown>> = []
  const responses: Response[] = []
  const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return responses.shift() ?? okId("sid")
  })
  const makeSender = (seq = 3) =>
    new StreamSender(
      {
        restBase: "https://api.bot.qq.com",
        getToken: () => Promise.resolve("TK"),
        fetchFn: fetchFn as typeof fetch,
      },
      { openid: "U", msgId: "MSG1", msgSeq: seq },
    )
  let warnSpy: MockInstance
  let errorSpy: MockInstance
  beforeEach(() => {
    bodies.length = 0
    responses.length = 0
    fetchFn.mockClear()
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    // 只恢复 console 间谍；restoreAllMocks 会连带清掉 fetchFn 的 mockImplementation
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
  return { bodies, responses, fetchFn, makeSender, get warn() { return warnSpy }, get error() { return errorSpy } }
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

describe("错误码解析与分级（!ok 时读 body 提取 err_code）", () => {
  const h = makeHarness()

  it("50002 限频：记 STREAM_RATE 日志，退避后重试一次并成功", async () => {
    h.responses.push(errRes(50002, 429), okRemain("R1"))
    const s = h.makeSender()
    await s.update("x")
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("STREAM003"))
    expect(h.bodies).toHaveLength(2) // 重试发生了
    expect(s.failed).toBe(false)
  }, 10000)

  it("50002 重试仅一次：再次失败则置 failed，不发第三次", async () => {
    h.responses.push(errRes(50002, 429), errRes(50002, 429))
    const s = h.makeSender()
    await s.update("x")
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    expect(s.failed).toBe(true)
    expect(h.warn).toHaveBeenCalledTimes(1) // 仅首次限频记录一次
  }, 10000)

  it("50001 服务端错误：记 STREAM_SERVER 日志并置 failed", async () => {
    h.responses.push(errRes(50001, 500))
    const s = h.makeSender()
    await s.update("x")
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("STREAM004"))
    expect(s.failed).toBe(true)
    expect(h.bodies).toHaveLength(1) // 不重试
  })

  it("40007 前缀冲突：记 STREAM_PREFIX 日志并置 failed", async () => {
    h.responses.push(errRes(40007))
    const s = h.makeSender()
    await s.update("a")
    await s.update("ab")
    expect(h.bodies).toHaveLength(1) // 首片失败后续不再发
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("STREAM002"))
    expect(s.failed).toBe(true)
  })

  it("其他 err_code：保持现有失败行为，不产生分级日志", async () => {
    h.responses.push(errRes(99999))
    const s = h.makeSender()
    await s.update("x")
    expect(s.failed).toBe(true)
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.error).not.toHaveBeenCalled()
  })

  it("body 非 JSON（无 err_code）：保持现有失败行为", async () => {
    h.responses.push(new Response("<html>err</html>", { status: 502 }))
    const s = h.makeSender()
    await s.update("x")
    expect(s.failed).toBe(true)
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.error).not.toHaveBeenCalled()
  })
})

describe("delivered 标志（任一分片送达即 true）", () => {
  const h = makeHarness()

  it("分片发送成功后 delivered 为 true", async () => {
    h.responses.push(okId("A"), okId("B"))
    const s = h.makeSender()
    expect(s.delivered).toBe(false)
    await s.update("x")
    expect(s.delivered).toBe(true)
  })

  it("从未成功送达时 delivered 保持 false", async () => {
    h.responses.push(new Response("", { status: 500 }))
    const s = h.makeSender()
    await s.update("x")
    expect(s.failed).toBe(true)
    expect(s.delivered).toBe(false)
  })
})

describe("续片/收尾携带 msg_id（官方示例要求）", () => {
  const h = makeHarness()

  it("每个分片 body 都携带被动引用的 msg_id", async () => {
    h.responses.push(okId("S1"), okId("s"), okId("s"))
    const s = h.makeSender()
    await s.update("a")
    await s.update("ab")
    await s.finish("abc")
    expect(h.bodies[0].msg_id).toBe("MSG1")
    expect(h.bodies[1]).toMatchObject({ input_state: 1, msg_id: "MSG1", stream_msg_id: "S1" })
    expect(h.bodies[2]).toMatchObject({ input_state: 10, msg_id: "MSG1" })
    expect(s.failed).toBe(false)
  })

  it("未 update 直接 finish 的补发首片与收尾片均携带 msg_id", async () => {
    h.responses.push(okId("S9"), okId("s"))
    const s = h.makeSender(2)
    await s.finish("完整回答")
    expect(h.bodies[0].msg_id).toBe("MSG1")
    expect(h.bodies[1].msg_id).toBe("MSG1")
    expect(s.failed).toBe(false)
  })
})

describe("remain_msg_len 解析与主动收尾", () => {
  const h = makeHarness()

  it("响应含 ext_info.remain_msg_len 时存入 lastRemainLen，缺省为 null", async () => {
    h.responses.push(okId("A"), okRemain("B", 150))
    const s = h.makeSender()
    expect(s.lastRemainLen).toBeNull()
    await s.update("a")
    expect(s.lastRemainLen).toBeNull() // 首片响应无 ext_info
    await s.update("ab")
    expect(s.lastRemainLen).toBe(150)
    expect(h.bodies).toHaveLength(2) // ≥100 不触发主动收尾
    expect(s.failed).toBe(false)
  })

  it("remain_msg_len < 100 时主动收尾：state=10、不置败、后续调用 no-op", async () => {
    h.responses.push(okRemain("A", 42))
    const s = h.makeSender()
    await s.update("正在写的内容")
    expect(s.lastRemainLen).toBe(42)
    expect(s.failed).toBe(false)
    expect(h.bodies).toHaveLength(2)
    expect(h.bodies[1]).toMatchObject({
      input_state: 10,
      index: 1,
      content_raw: "正在写的内容",
      msg_id: "MSG1",
      stream_msg_id: "A",
    })
    const n = h.bodies.length
    await s.finish("正在写的内容。") // 已自动收尾 → no-op
    await s.update("正在写的内容。更多")
    expect(h.bodies).toHaveLength(n)
  })

  it("remain_msg_len ≥ 100 不主动收尾", async () => {
    h.responses.push(okRemain("A", 100))
    const s = h.makeSender()
    await s.update("a")
    expect(h.bodies).toHaveLength(1)
    expect(s.failed).toBe(false)
  })

  it("自动收尾后，队列中已排队的续片不再发送（state=10 之后无续片）", async () => {
    const resolvers: Array<(r: Response) => void> = []
    h.fetchFn.mockImplementation(async (_url: string, init?: { body?: unknown }) => {
      h.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Promise<Response>((resolve) => resolvers.push(resolve))
    })
    const s = h.makeSender()
    const p1 = s.update("a")
    const p2 = s.update("ab") // 排队，尚未发请求
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    resolvers[0](okRemain("A", 7)) // 放行首片：成功但余量告急 → 触发主动收尾
    await vi.waitFor(() => expect(h.bodies).toHaveLength(2))
    expect(h.bodies[1]).toMatchObject({ input_state: 10 })
    resolvers[1](okId("F")) // 放行收尾片
    await p1 // 含内联收尾
    await p2 // 排队续片应被丢弃
    expect(h.bodies).toHaveLength(2)
    expect(s.failed).toBe(false)
    expect(s.lastRemainLen).toBe(7)
    expect(s.delivered).toBe(true)
  })
})

describe("首片缺 id 视为失败（STREAM001）", () => {
  const h = makeHarness()

  it("HTTP ok 但 body 无 id：记 STREAM_BEGIN_FAIL 并置 failed", async () => {
    h.responses.push(new Response(JSON.stringify({}), { status: 200 }))
    const s = h.makeSender()
    await s.update("x")
    expect(s.failed).toBe(true)
    expect(s.delivered).toBe(false)
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("STREAM001"))
  })

  it("首片缺 id 后续不再发送", async () => {
    h.responses.push(new Response(JSON.stringify({}), { status: 200 }), okId("B"))
    const s = h.makeSender()
    await s.update("x")
    await s.finish("xyz")
    expect(h.bodies).toHaveLength(1)
    expect(s.failed).toBe(true)
  })

  it("续片响应缺 id 不影响已建立的流", async () => {
    h.responses.push(okId("A"), new Response(JSON.stringify({}), { status: 200 }))
    const s = h.makeSender()
    await s.update("a")
    expect(s.failed).toBe(false)
    expect(s.delivered).toBe(true)
  })
})
