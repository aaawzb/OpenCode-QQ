import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config"

afterEach(() => {
  delete process.env.QQ_BOT_APPID
  delete process.env.QQ_BOT_APPSECRET
})

describe("loadConfig", () => {
  it("缺 appId 时返回 null（静默禁用）", async () => {
    const cfg = loadConfig("/nonexistent/path.json")
    expect(cfg).toBeNull()
  })
  it("环境变量提供完整凭据时可用，默认 sandbox=true", async () => {
    process.env.QQ_BOT_APPID = "111"
    process.env.QQ_BOT_APPSECRET = "sec"
    const cfg = loadConfig("/nonexistent/path.json")!
    expect(cfg.appId).toBe("111")
    expect(cfg.appSecret).toBe("sec")
    expect(cfg.sandbox).toBe(true)
    expect(cfg.allowlist).toEqual([])
    expect(cfg.events.toolProgress).toBe(false)
  })
  it("文件配置被读取，环境变量覆盖文件值", async () => {
    const os = await import("node:os")
    const fs = await import("node:fs")
    const path = `${fs.mkdtempSync(`${os.tmpdir()}/qqcfg-`)}/cfg.json`
    fs.writeFileSync(
      path,
      JSON.stringify({
        appId: "file-id",
        appSecret: "file-secret",
        sandbox: false,
        model: "anthropic/claude-sonnet-4-5",
      }),
    )
    process.env.QQ_BOT_APPID = "env-id"
    const cfg = loadConfig(path)!
    expect(cfg.appId).toBe("env-id")
    expect(cfg.appSecret).toBe("file-secret")
    expect(cfg.sandbox).toBe(false)
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-5")
  })
  it("markdownReply 与 streaming 默认 true，可显式关闭", async () => {
    process.env.QQ_BOT_APPID = "a"
    process.env.QQ_BOT_APPSECRET = "b"
    const cfg = loadConfig("/nonexistent")!
    expect(cfg.markdownReply).toBe(true)
    expect(cfg.streaming).toBe(true)
  })
})
