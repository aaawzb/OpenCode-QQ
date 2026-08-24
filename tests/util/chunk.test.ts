import { describe, expect, it } from "vitest"
import { splitText } from "../../src/util/chunk"

describe("splitText", () => {
  it("短文本原样返回单条", () => {
    expect(splitText("hello", 100)).toEqual(["hello"])
  })
  it("按字节上限切分且不产生空片段", () => {
    const parts = splitText("ab".repeat(1500), 1000)
    for (const p of parts) {
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(1000)
      expect(p.length).toBeGreaterThan(0)
    }
    expect(parts.join("")).toBe("ab".repeat(1500))
  })
  it("优先在换行处切分", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50)
    const parts = splitText(text, 60)
    expect(parts[0].endsWith("\n") || parts.length === 1).toBe(true)
  })
  it("多字节字符不被切成乱码", () => {
    const text = "中".repeat(600) // 每个 3 字节
    const parts = splitText(text, 900) // 恰好 300 字/条边界
    for (const p of parts) expect(p).toMatch(/^中+$/)
  })
})
