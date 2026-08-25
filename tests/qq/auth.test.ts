import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthManager } from "../../src/qq/auth"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function captureConsole() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  }
}

describe("AuthManager", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.restoreAllMocks())

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

  it("HTTP 非 200 抛错并记录 AUTH001", async () => {
    const spy = captureConsole()
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ code: 100016 }, 400))
    const am = new AuthManager("id", "bad", fetchFn as typeof fetch)
    await expect(am.getToken()).rejects.toThrow(/getAppAccessToken/)
    expect(spy.error).toHaveBeenCalledWith(expect.stringContaining("[opencode-qq][auth:AUTH001]"))
    expect(spy.error).toHaveBeenCalledWith(expect.stringContaining("400"))
  })

  it("HTTP 200 但缺少 access_token：记 AUTH002、抛错且不写入缓存", async () => {
    const spy = captureConsole()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "ip not in whitelist" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T1", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await expect(am.getToken()).rejects.toThrow(/getAppAccessToken/)
    expect(spy.error).toHaveBeenCalledWith(expect.stringContaining("[opencode-qq][auth:AUTH002]"))
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(await am.getToken()).toBe("T1")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("err_code=100001：warn(AUTH003) 后延迟 1 秒自动重试一次并成功", async () => {
    const spy = captureConsole()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ err_code: 100001, message: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T9", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    const pending = am.getToken()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBe("T9")
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(spy.warn).toHaveBeenCalledWith(expect.stringContaining("[opencode-qq][auth:AUTH003]"))
  })

  it("err_code=100001 重试仍失败：只重试一次即抛错", async () => {
    captureConsole()
    const fetchFn = vi.fn().mockImplementation(() => jsonResponse({ err_code: 100001 }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    const pending = am.getToken()
    const captured: Promise<unknown> = pending.then(
      () => null,
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const err = await captured
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/getAppAccessToken/)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["err_code=100007 记 AUTH004", { err_code: 100007, message: "invalid appid" }, "AUTH004"],
    ["code=10004 记 AUTH004", { code: "10004", message: "invalid appid" }, "AUTH004"],
    ["err_code=100016 记 AUTH005", { err_code: 100016, message: "invalid secret" }, "AUTH005"],
    ["未知 err_code=11253 记 AUTH006 附 detail", { err_code: 11253, message: "ip denied" }, "AUTH006"],
  ])("%s", async (_name, body, code) => {
    const spy = captureConsole()
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(body))
    const am = new AuthManager("id", "bad", fetchFn as typeof fetch)
    await expect(am.getToken()).rejects.toThrow(/getAppAccessToken/)
    expect(spy.error).toHaveBeenCalledWith(expect.stringContaining(`[opencode-qq][auth:${code}]`))
    if (code === "AUTH006") {
      expect(spy.error).toHaveBeenCalledWith(expect.stringContaining("11253"))
    }
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("并发 getToken 共享同一进行中的请求（单飞）", async () => {
    let resolve!: (v: Response) => void
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolve = res
        }),
    )
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    const p1 = am.getToken()
    const p2 = am.getToken()
    resolve(jsonResponse({ access_token: "TS", expires_in: "7200" }))
    expect(await p1).toBe("TS")
    expect(await p2).toBe("TS")
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("过期瞬间的并发 getToken 只触发一次刷新", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "T1", expires_in: "60" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T2", expires_in: "60" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await am.getToken()
    vi.advanceTimersByTime(61_000)
    const [a, b] = await Promise.all([am.getToken(), am.getToken()])
    expect(a).toBe("T2")
    expect(b).toBe("T2")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
