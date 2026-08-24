type Json = unknown

/** 官方未完全文档化 message_type=103 的 msg_elements 结构，做防御性递归提取 */
export function extractQuotedText(d: Record<string, unknown>): string {
  if (Number(d.message_type) !== 103) return ""
  const out: string[] = []
  const walk = (node: Json): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>
      if (typeof obj.content === "string" && obj.content.trim()) out.push(obj.content)
      if (obj.text_element) walk(obj.text_element)
      for (const key of Object.keys(obj)) {
        if (key !== "content" && key !== "text_element") walk(obj[key])
      }
    }
  }
  walk(d.msg_elements)
  return out.join("\n").slice(0, 2000)
}
