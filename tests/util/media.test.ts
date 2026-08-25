import { describe, expect, it, vi } from "vitest"
import { guessImageMime, toImageDataUrl, mimeFromContentType, saveAttachment } from "../../src/util/media"

describe("guessImageMime", () => {
  it("按扩展名推断", () => {
    expect(guessImageMime("https://x/a.PNG")).toBe("image/png")
    expect(guessImageMime("https://x/a.jpg")).toBe("image/jpeg")
    expect(guessImageMime("https://x/a.webp?q=1")).toBe("image/webp")
    expect(guessImageMime("https://x/a")).toBe("image/png") // 默认
  })
})

describe("mimeFromContentType", () => {
  it("QQ 的 content_type 带子类型，直接映射", () => {
    expect(mimeFromContentType("image/jpeg", "https://x/download")).toBe("image/jpeg")
    expect(mimeFromContentType("image/png", "")).toBe("image/png")
  })
  it("非 image/ 前缀回退扩展名推断", () => {
    expect(mimeFromContentType("file", "https://x/a.png")).toBe("image/png")
  })
})

describe("toImageDataUrl", () => {
  it("下载并编码为 data URL（mime 由调用方传入）", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const fetchFn = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }))
    const url = await toImageDataUrl("https://cdn/download?appid=1", fetchFn as typeof fetch, "image/jpeg")
    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`)
  })
})

describe("saveAttachment", () => {
  it("下载文件保存到目标目录，文件名带时间戳防覆盖", async () => {
    const os = await import("node:os")
    const fs = await import("node:fs")
    const path = await import("node:path")
    const dir = fs.mkdtempSync(`${os.tmpdir()}/qqfile-`)
    const fetchFn = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const saved = await saveAttachment("https://x/f.docx", "文档(1).docx", dir, fetchFn as typeof fetch)
    expect(saved.path).toContain("文档(1).docx")
    expect(fs.existsSync(saved.path)).toBe(true)
    expect(fs.readFileSync(saved.path).length).toBe(3)
    expect(path.basename(saved.path)).toMatch(/^\d{4}\d{2}\d{2}-\d{6}-文档\(1\)\.docx$/)
  })
  it("下载失败抛错", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 403 }))
    await expect(saveAttachment("https://x/f", "a.txt", "Z:/nonexistent", fetchFn as typeof fetch)).rejects.toThrow(/403|save/)
  })
})
