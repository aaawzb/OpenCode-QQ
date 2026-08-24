import { describe, expect, it } from "vitest"
import { mergeCredentials } from "../src/setup-core"

describe("mergeCredentials", () => {
  it("合并凭据进已有配置并保留其他字段", () => {
    const merged = JSON.parse(
      mergeCredentials('{"sandbox":false,"allowlist":["X"]}', {
        appId: "A",
        appSecret: "S",
      }),
    )
    expect(merged).toEqual({
      appId: "A",
      appSecret: "S",
      sandbox: false,
      allowlist: ["X"],
    })
  })
  it("非法 JSON 视为空配置", () => {
    const merged = JSON.parse(mergeCredentials("{broken", { appId: "A", appSecret: "S" }))
    expect(merged.appId).toBe("A")
  })
})
