import { describe, expect, it, vi } from "vitest"
import { guessImageMime, toImageDataUrl } from "../../src/util/media"

describe("guessImageMime", () => {
  it("按扩展名推断", () => {
    expect(guessImageMime("https://x/a.PNG")).toBe("image/png")
    expect(guessImageMime("https://x/a.jpg")).toBe("image/jpeg")
    expect(guessImageMime("https://x/a.webp?q=1")).toBe("image/webp")
    expect(guessImageMime("https://x/a")).toBe("image/png") // 默认
  })
})

describe("toImageDataUrl", () => {
  it("下载并编码为 data URL", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const fetchFn = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }))
    const url = await toImageDataUrl("https://cdn/a.png", fetchFn as typeof fetch)
    expect(url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`)
  })
})
