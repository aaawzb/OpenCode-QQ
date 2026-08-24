import fs from "node:fs"
import { parseCommand } from "./commands.js"

/** opencode client 的最小交互面（index.ts 负责适配真实 SDK） */
export interface OpencodeBridge {
  sessionCreate(title: string): Promise<{ id: string }>
  /** noReply=true 注入上下文不触发回复；false 触发 AI 并返回消息 parts */
  sessionPrompt(
    id: string,
    text: string,
    noReply: boolean,
    files?: Array<{ mime: string; dataUrl: string }>,
  ): Promise<{ parts: Array<{ type: string; text?: string }> }>
  resolveModel(): Promise<{ providerID: string; modelID: string }>
  /** 可选：会话被 /new 重置时通知（index.ts 用它清空待审请求） */
  onSessionReset?(sessionId: string): void
}

export class SessionManager {
  private map = new Map<string, string>()

  constructor(
    private bridge: OpencodeBridge,
    private persistPath: string,
    private fsMod: Pick<typeof fs, "readFileSync" | "writeFileSync"> = fs,
    /** 终审 I4a：可选，返回某会话当前待审批数（/status 展示） */
    private pendingCount?: (sessionId: string) => number,
  ) {
    try {
      const raw = JSON.parse(this.fsMod.readFileSync(persistPath, "utf8")) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
    } catch {
      /* 首次运行无文件 */
    }
  }

  async getSessionId(openid: string): Promise<string | null> {
    return this.map.get(openid) ?? null
  }

  isOurSession(sessionId: string): boolean {
    for (const sid of this.map.values()) if (sid === sessionId) return true
    return false
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map)
  }

  reset(openid: string): void {
    const sid = this.map.get(openid)
    this.map.delete(openid)
    this.persist()
    if (sid) this.bridge.onSessionReset?.(sid)
  }

  /** 返回要发回 QQ 的文本 */
  async dispatch(
    openid: string,
    text: string,
    files: Array<{ mime: string; dataUrl: string }> = [],
  ): Promise<string> {
    const cmd = parseCommand(text)
    if (cmd) {
      switch (cmd.type) {
        case "new":
          this.reset(openid)
          return "已重置会话，下次消息将开启新对话。"
        case "status":
          return this.statusReply(openid)
        case "help":
          return [
            "opencode-qq 指令:",
            "/new — 重置当前会话",
            "/status — 查看会话状态",
            "/help — 本帮助",
            "其余文本将直接交给 opencode 处理。",
          ].join("\n")
      }
    }

    let sessionId = await this.getSessionId(openid)
    if (!sessionId) {
      const title = text.slice(0, 20)
      const created = await this.bridge.sessionCreate(title)
      sessionId = created.id
      this.map.set(openid, sessionId)
      this.persist()
      await this.bridge.sessionPrompt(sessionId, "以下用户将通过 QQ 单聊与你对话，回答请精炼。", true)
    }
    const result = await this.bridge.sessionPrompt(sessionId, text, false, files)
    const out = result.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
    return out || "(无文本回复)"
  }

  private async statusReply(openid: string): Promise<string> {
    const sid = await this.getSessionId(openid)
    if (!sid) return "暂无会话，发任意消息即可开始。"
    let reply = `当前会话: ${sid}\n状态: 已就绪`
    const pending = this.pendingCount?.(sid)
    if (pending !== undefined) reply += `\n待审批: ${pending} 条`
    return reply
  }

  private persist(): void {
    try {
      this.fsMod.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.map)))
    } catch {
      /* 写失败不影响主流程 */
    }
  }
}
