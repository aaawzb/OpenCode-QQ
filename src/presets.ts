import fs from "node:fs"

/** 宽松 JSONC 解析：去 // 与 /* *​/ 注释、去尾逗号 */
export function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped) as Record<string, unknown>
}

/** 读取 opencode 主配置（opencode.jsonc / opencode.json）；不存在返回空对象 */
export function readOpencodeConfig(explicitPath?: string): Record<string, unknown> {
  const root = process.env.XDG_CONFIG_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? ""
  const candidates = explicitPath
    ? [explicitPath]
    : [`${root}/.config/opencode/opencode.jsonc`, `${root}/.config/opencode/opencode.json`]
  for (const p of candidates) {
    try {
      return parseJsonc(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""))
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return {}
}

export interface ModelPreset {
  id: string // "providerID/modelID"
  label: string
  thinking: boolean
}

interface ProviderCfg {
  models?: Record<string, { name?: string; reasoning?: boolean }>
}

/** 扫描 opencode 配置的 provider.models，排除 disabled_providers，生成模型预设 */
export function listModelPresets(cfg: Record<string, unknown>): ModelPreset[] {
  const providers = (cfg.provider ?? {}) as Record<string, ProviderCfg>
  const disabled = new Set((Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : []) as string[])
  const out: ModelPreset[] = []
  for (const [pid, pcfg] of Object.entries(providers)) {
    if (disabled.has(pid)) continue
    for (const [mid, m] of Object.entries(pcfg.models ?? {})) {
      out.push({
        id: `${pid}/${mid}`,
        label: m.name ?? mid,
        thinking: m.reasoning === true,
      })
    }
  }
  return out
}

/** 查询服务器会话记录，按 directory 去重生成工作区候选 */
export async function listWorkdirs(
  serverUrl: string,
  auth: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchFn(`${serverUrl}/session`, {
    headers: { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`list sessions failed: HTTP ${res.status}`)
  const sessions = (await res.json()) as Array<{ directory?: string }>
  const seen = new Set<string>()
  for (const s of sessions) {
    if (s.directory) seen.add(s.directory)
  }
  return [...seen]
}
