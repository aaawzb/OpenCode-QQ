import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuthManager } from "../../src/qq/auth"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe("AuthManager", () => {
  beforeEach(() => vi.useFakeTimers())

  it("首次调用请求 token，body 含 appId/clientSecret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "T1", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    expect(await am.getToken()).toBe("T1")
    expect(fetchFn).toHaveBeenCalledOnce()
    const [, init] = fetchFn.mock.calls[0]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ appId: "id", clientSecret: "secret" })
  })

  it("有效期内复用缓存 token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "T1", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await am.getToken()
    await am.getToken()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("距过期不足 60 秒时刷新新 token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "T1", expires_in: "7200" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T2", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await am.getToken()
    vi.advanceTimersByTime((7200 - 30) * 1000) // 距过期剩 30 秒
    expect(await am.getToken()).toBe("T2")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("HTTP 非 200 抛错", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ code: 100016 }, 400))
    const am = new AuthManager("id", "bad", fetchFn as typeof fetch)
    await expect(am.getToken()).rejects.toThrow(/getAppAccessToken/)
  })
})
