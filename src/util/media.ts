import fs from "node:fs"
import path from "node:path"

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

export function guessImageMime(url: string): string {
  const clean = url.split("?")[0] ?? ""
  const ext = clean.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "image/png"
}

/**
 * QQ attachments 的 content_type 带子类型（如 "image/jpeg"），
 * 直接作为 mime；非 image/ 前缀（如 "file"）回退扩展名推断。
 */
export function mimeFromContentType(contentType: string, url: string): string {
  if (contentType.startsWith("image/")) return contentType
  return guessImageMime(url)
}

export async function toImageDataUrl(
  url: string,
  fetchFn: typeof fetch = fetch,
  mime?: string,
): Promise<string> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`download attachment failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const type = mime ?? guessImageMime(url)
  return `data:${type};base64,${buf.toString("base64")}`
}

export interface SavedAttachment {
  path: string
  filename: string
  size: number
}

/** 下载附件保存到 dir，文件名加时间戳防覆盖（QQ 文件 URL 的 rkey 有时效，须尽快下载） */
export async function saveAttachment(
  url: string,
  filename: string,
  dir: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedAttachment> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`download attachment failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_") || "file"
  const full = path.join(dir, `${stamp}-${safeName}`)
  fs.writeFileSync(full, buf)
  return { path: full, filename: safeName, size: buf.length }
}
