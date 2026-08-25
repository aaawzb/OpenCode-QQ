import { afterEach, describe, expect, it, vi } from "vitest"
import { QQApi } from "../../src/qq/api"

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

function mkApi(fetchFn: ReturnType<typeof vi.fn>) {
  return new QQApi({
    restBase: "https://api.bot.qq.com",
    getToken: () => Promise.resolve("TK"),
    fetchFn: fetchFn as typeof fetch,
  })
}

describe("QQApi.sendC2C", () => {
  it("发送文本消息并携带 Authorization 头与 msg_seq 自增", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m1" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await api.sendC2C("OPENID", "hi", { msgId: "MSG1" })
    await api.sendC2C("OPENID", "hi2", { msgId: "MSG1" })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://api.bot.qq.com/v2/users/OPENID/messages")
    expect(init.headers.Authorization).toBe("QQBot TK")
    // 注意：实现向 fetchFn 传入的是 JSON 字符串，断言前需解析
    const body1 = JSON.parse(init.body)
    expect(body1.msg_type).toBe(0)
    expect(body1.content).toBe("hi")
    expect(body1.msg_id).toBe("MSG1")
    expect(body1.msg_seq).toBe(1)
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).msg_seq).toBe(2)
  })

  it("429 按 Retry-After 退避重试后成功", async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(okJson({ id: "ok" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    const p = api.sendC2C("O", "retry me")
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(fetchFn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("同一 msg_id 超过 4 条被动回复后降级为主动消息（去掉 msg_id）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    for (let i = 0; i < 5; i++) await api.sendC2C("O", `r${i}`, { msgId: "MSG9" })
    expect(JSON.parse(fetchFn.mock.calls[3][1].body).msg_id).toBe("MSG9")
    expect(JSON.parse(fetchFn.mock.calls[4][1].body).msg_id).toBeUndefined()
  })

  it("format=markdown 发送 msg_type=2 且失败降级为纯文本重试一次", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(okJson({ id: "m" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await api.sendC2C("O", "# 标题", { msgId: "MD1", format: "markdown" })
    const body1 = JSON.parse(fetchFn.mock.calls[0][1].body)
    const body2 = JSON.parse(fetchFn.mock.calls[1][1].body)
    expect(body1.msg_type).toBe(2)
    expect(body1.markdown.content).toBe("# 标题")
    expect(body2.msg_type).toBe(0)
    expect(body2.content).toBe("# 标题")
    expect(body2.msg_seq).toBe(body1.msg_seq)
  })
})

describe("QQApi event_id 被动回复与互动应答", () => {
  function make() {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    return { api, fetchFn }
  }
  it("eventId 被动回复：body 带 event_id 不带 msg_id/msg_seq", async () => {
    const { api, fetchFn } = make()
    await api.sendC2C("O", "已批准 #3", { eventId: "EVT1" })
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.event_id).toBe("EVT1")
    expect(body.msg_id).toBeUndefined()
    expect(body.msg_seq).toBeUndefined()
  })
  it("putInteraction PUT 正确 URL 与 body", async () => {
    const { api, fetchFn } = make()
    await api.putInteraction("IID", 0)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://api.bot.qq.com/interactions/IID")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({ code: 0 })
  })
  it("putInteraction 超时 2.5 秒", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockImplementation(
      (_u: string, i?: { signal?: AbortSignal }) =>
        new Promise((_ok, bad) => i?.signal?.addEventListener("abort", () => bad(new Error("timeout")))),
    )
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    const p = api.putInteraction("IID", 0)
    const assertion = expect(p).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(2600)
    await assertion
    vi.useRealTimers()
  })
})

describe("QQApi 超时守卫", () => {
  afterEach(() => vi.restoreAllMocks())

  it("fetch 携带 AbortSignal 超时信号(15s)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
    const api = mkApi(fetchFn)
    await api.sendC2C("O", "hi")
    expect(fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it.each(["TimeoutError", "AbortError"])(
    "markdown 发生 %s 超时不降级文本重发，直接按 MSG001 失败",
    async (name) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const fetchFn = vi.fn().mockRejectedValue(Object.assign(new Error("aborted due to timeout"), { name }))
      const api = mkApi(fetchFn)
      await expect(
        api.sendC2C("O", "# md", { msgId: "MT", format: "markdown" }),
      ).rejects.toThrow(/aborted/)
      expect(fetchFn).toHaveBeenCalledTimes(1) // 响应可能已送达，禁止重发
      const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(line).toContain("[opencode-qq][api:MSG001]")
      expect(line).toContain("超时")
      expect(warnSpy).not.toHaveBeenCalled()
    },
  )
})

describe("QQApi err_code 分类", () => {
  afterEach(() => vi.restoreAllMocks())

  it("err_code=40034100 视为频控：记 MSG002 并按 429 同样退避重试", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 40034100, message: "too fast" }), { status: 400 }),
        )
        .mockResolvedValueOnce(okJson({ id: "ok" }))
      const api = mkApi(fetchFn)
      const p = api.sendC2C("O", "hi")
      await vi.advanceTimersByTimeAsync(2000)
      await p
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[opencode-qq][api:MSG002]"))
      expect(String(errSpy.mock.calls[0][0])).toContain("40034100")
    } finally {
      vi.useRealTimers()
    }
  })

  it("其他错误码附入 MSG001 日志详情（err_code/message/body 摘要）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ err_code: 50001, message: "server boom" }), { status: 500 }),
    )
    const api = mkApi(fetchFn)
    await expect(api.sendC2C("O", "hi")).rejects.toThrow(/HTTP 500/)
    const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(line).toContain("[opencode-qq][api:MSG001]")
    expect(line).toContain("err_code=50001")
    expect(line).toContain("server boom")
  })
})

describe("QQApi seqCounters 淘汰策略", () => {
  it("超过 500 时仅按插入序淘汰最旧 100 个键，幸存键计数保留", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
    const api = mkApi(fetchFn)
    for (let i = 0; i < 505; i++) await api.sendC2C("O", `m${i}`, { msgId: `K${i}` })
    // 插入第 501 个键时淘汰 K0..K99；K100..K504 幸存且计数保留
    await api.sendC2C("O", "again-evicted", { msgId: "K0" })
    await api.sendC2C("O", "again-survivor", { msgId: "K100" })
    const bodies = fetchFn.mock.calls.map((c) => JSON.parse(c[1].body))
    expect(bodies[505].msg_seq).toBe(1) // K0 已被淘汰 → 从头计数
    expect(bodies[506].msg_seq).toBe(2) // K100 幸存 → 续接计数
  })
})

describe("QQApi 额度用尽日志", () => {
  it("被动额度用尽降级主动消息时输出 MSG003 并带 msgId", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
    const api = mkApi(fetchFn)
    for (let i = 0; i < 5; i++) await api.sendC2C("O", `r${i}`, { msgId: "MSGX" })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[opencode-qq][api:MSG003]"))
    const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("MSG003"))
    expect(line).toContain("MSGX")
  })
})
