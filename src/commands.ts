export type Command =
  | { type: "new" }
  | { type: "status" }
  | { type: "help" }
  | { type: "interrupt" }
  | { type: "continue" }
  | { type: "retry" }

export function parseCommand(text: string): Command | null {
  const m = /^\/(new|status|help|interrupt|continue|retry)\s*$/i.exec(text.trim())
  if (!m) return null
  return { type: m[1].toLowerCase() } as Command
}
