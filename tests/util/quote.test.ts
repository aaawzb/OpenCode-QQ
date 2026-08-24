import { describe, expect, it } from "vitest"
import { extractQuotedText } from "../../src/util/quote"

describe("extractQuotedText", () => {
  it("从 msg_elements 提取引用文本", () => {
    const d = {
      message_type: 103,
      msg_elements: [{ text_element: { content: "被引用的原话" } }],
    }
    expect(extractQuotedText(d)).toBe("被引用的原话")
  })
  it("嵌套 content 字段兜底提取", () => {
    const d = { message_type: 103, msg_elements: [{ content: "另一种结构" }] }
    expect(extractQuotedText(d)).toBe("另一种结构")
  })
  it("非引用消息或解析不出返回空串", () => {
    expect(extractQuotedText({ message_type: 0 })).toBe("")
    expect(extractQuotedText({ message_type: 103 })).toBe("")
    expect(extractQuotedText({ msg_elements: [{ image_element: {} }] })).toBe("")
  })
})
