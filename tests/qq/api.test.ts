import { describe, expect, it, vi } from "vitest"
import { QQApi } from "../../src/qq/api"

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
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
