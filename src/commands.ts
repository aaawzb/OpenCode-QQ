export type Command =
  | { type: "new" }
  | { type: "status" }
  | { type: "help" }
  | { type: "interrupt" }
  | { type: "continue" }
  | { type: "retry" }
  | { type: "model"; arg?: string }
  | { type: "thinking"; arg?: "high" | "low" }
  | { type: "workdir"; arg?: string }
  | { type: "session"; arg?: string }

export function parseCommand(text: string): Command | null {
  const m = /^\/(new|status|help|interrupt|continue|retry|model|thinking|workdir|session)(?:\s+(\S+))?\s*$/i.exec(
    text.trim(),
  )
  if (!m) return null
  const type = m[1].toLowerCase()
  const arg = m[2]
  if (type === "thinking") {
    const v = arg?.toLowerCase()
    if (v !== "high" && v !== "low") return null
    return { type, arg: v }
  }
  if (type === "model" || type === "workdir" || type === "session") {
    if (arg !== undefined && !/^\d+$/.test(arg)) return null // 参数必须为序号
    return { type, arg } as Command
  }
  return { type } as Command
}
