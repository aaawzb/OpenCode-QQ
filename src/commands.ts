export type Command = { type: "new" } | { type: "status" } | { type: "help" }

export function parseCommand(text: string): Command | null {
  const m = /^\/(new|status|help)\s*$/i.exec(text.trim())
  if (!m) return null
  return { type: m[1].toLowerCase() } as Command
}
