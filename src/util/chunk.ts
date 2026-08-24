export function splitText(text: string, maxBytes = 1900): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text ? [text] : []
  const parts: string[] = []
  let current = ""
  let currentBytes = 0
  for (const seg of text.split(/(?<=\n)/)) {
    const segBytes = Buffer.byteLength(seg, "utf8")
    if (segBytes > maxBytes) {
      if (current) {
        parts.push(current)
        current = ""
        currentBytes = 0
      }
      let buf = ""
      let bufBytes = 0
      for (const ch of seg) {
        const chBytes = Buffer.byteLength(ch, "utf8")
        if (bufBytes + chBytes > maxBytes) {
          parts.push(buf)
          buf = ch
          bufBytes = chBytes
        } else {
          buf += ch
          bufBytes += chBytes
        }
      }
      current = buf
      currentBytes = bufBytes
      continue
    }
    if (currentBytes + segBytes > maxBytes) {
      parts.push(current)
      current = seg
      currentBytes = segBytes
    } else {
      current += seg
      currentBytes += segBytes
    }
  }
  if (current) parts.push(current)
  return parts
}
