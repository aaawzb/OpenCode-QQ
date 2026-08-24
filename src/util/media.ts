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

export async function toImageDataUrl(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`download attachment failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${guessImageMime(url)};base64,${buf.toString("base64")}`
}
