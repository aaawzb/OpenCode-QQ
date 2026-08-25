import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { listModelPresets, listModelPresetsWithBuiltin, listWorkdirs, readOpencodeConfig } from "../src/presets"

function writeConfig(content: string): string {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/qqpreset-`)
  const p = path.join(dir, "opencode.jsonc")
  fs.writeFileSync(p, content)
  return p
}

describe("readOpencodeConfig", () => {
  it("解析标准 JSON", () => {
    const p = writeConfig(`{"provider":{"a":{"models":{"m1":{"name":"M1"}}}}}`)
    expect(readOpencodeConfig(p).provider.a.models.m1.name).toBe("M1")
  })
  it("容忍注释与尾逗号（JSONC）", () => {
    const p = writeConfig(`{
      // 提供商
      "provider": { "a": { "models": { "m1": {} } }, },
    }`)
    expect(readOpencodeConfig(p).provider.a.models.m1).toBeDefined()
  })
  it("文件不存在返回空对象", () => {
    expect(readOpencodeConfig("/nonexistent/x.jsonc")).toEqual({})
  })
})

describe("listModelPresets", () => {
  it("扫描 provider.models，排除 disabled，标记 reasoning", () => {
    const cfg = {
      provider: {
        p1: { models: { "fast-1": { name: "快速" }, "deep-1": { name: "深度", reasoning: true } } },
        p2: { models: { "m2": {} } },
      },
      disabled_providers: ["p2"],
    }
    const presets = listModelPresets(cfg as never)
    expect(presets).toEqual([
      { id: "p1/fast-1", label: "快速", thinking: false },
      { id: "p1/deep-1", label: "深度", thinking: true },
    ])
  })
  it("无 name 时用 modelID 作 label", () => {
    const cfg = { provider: { p: { models: { solo: {} } } } }
    expect(listModelPresets(cfg as never)[0].label).toBe("solo")
  })
})

describe("listWorkdirs", () => {
  it("从会话列表去重目录", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "1", directory: "D:\\A" },
          { id: "2", directory: "D:\\A" },
          { id: "3", directory: "D:\\B" },
        ]),
        { status: 200 },
      ),
    )
    const dirs = await listWorkdirs("http://x", "auth", fetchFn as typeof fetch)
    expect(dirs).toEqual(["D:\\A", "D:\\B"])
  })
})

describe("listModelPresetsWithBuiltin", () => {
  it("配置为空时仍有内置免费模型", () => {
    expect(listModelPresetsWithBuiltin({})).toEqual([
      { id: "opencode/x-preview-f-free", label: "OpenCode 免费模型", thinking: false },
    ])
  })
  it("扫描结果在前，内置追加在末尾", () => {
    const cfg = { provider: { p: { models: { "x-preview-f-free": { name: "免费" } } } } }
    const presets = listModelPresetsWithBuiltin(cfg)
    expect(presets).toEqual([
      { id: "p/x-preview-f-free", label: "免费", thinking: false },
      { id: "opencode/x-preview-f-free", label: "OpenCode 免费模型", thinking: false },
    ])
  })
})
