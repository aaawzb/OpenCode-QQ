import fs from "node:fs"
import { parseCommand } from "./commands.js"

/** opencode client 的最小交互面（index.ts 负责适配真实 SDK） */
export interface OpencodeBridge {
  sessionCreate(title: string, directory?: string): Promise<{ id: string }>
  /** noReply=true 注入上下文不触发回复；false 触发 AI 并返回消息 parts */
  sessionPrompt(
    id: string,
    text: string,
    noReply: boolean,
    files?: Array<{ mime: string; dataUrl: string }>,
    opts?: { model?: { providerID: string; modelID: string }; directory?: string },
  ): Promise<{ parts: Array<{ type: string; text?: string }> }>
  resolveModel(): Promise<{ providerID: string; modelID: string }>
  /** 可选：会话被 /new 重置时通知（index.ts 用它清空待审请求） */
  onSessionReset?(sessionId: string): void
  /** 可选：中断会话当前任务（/interrupt 指令） */
  sessionInterrupt?(sessionId: string): Promise<void>
  /** 可选：列出某工作区下的会话（/session 指令） */
  sessionList?(directory?: string): Promise<Array<{ id: string; title: string }>>
}

/** 模型/工作区/会话列表的查询能力（presets.ts 与服务器 API 的适配层） */
export interface SessionOps {
  listModels(): Array<{ id: string; label: string; thinking: boolean }>
  defaultModel(): { providerID: string; modelID: string }
  listWorkdirs(): Promise<string[]>
  listSessions(directory?: string): Promise<Array<{ id: string; title: string }>>
}

interface UserModelChoice {
  providerID: string
  modelID: string
  label: string
}

export class SessionManager {
  private map = new Map<string, string>()
  /** 每用户最近一条非指令消息（/retry 用），随实例生命周期 */
  private lastUserText = new Map<string, string>()
  private userModel = new Map<string, UserModelChoice>()
  private userWorkdir = new Map<string, string>()

  constructor(
    private bridge: OpencodeBridge,
    private persistPath: string,
    private fsMod: Pick<typeof fs, "readFileSync" | "writeFileSync"> = fs,
    /** 可选，返回某会话当前待审批数（/status 展示） */
    private pendingCount?: (sessionId: string) => number,
    /** 可选：模型/工作区/会话查询能力（缺失时相关指令提示未配置） */
    private ops?: SessionOps,
  ) {
    try {
      const raw = JSON.parse(this.fsMod.readFileSync(persistPath, "utf8")) as Record<string, string>
      for (const [k, v] of Object.entries(raw)) {
        if (k) this.map.set(k, v) // 跳过历史遗留的空键（openid 提取 bug 时代产物）
      }
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
        case "interrupt": {
          const sid = await this.getSessionId(openid)
          if (!sid) return "暂无进行中的会话。"
          await this.bridge.sessionInterrupt?.(sid)
          return "已中断当前任务。"
        }
        case "continue": {
          const sid = await this.getSessionId(openid)
          if (!sid) return "暂无进行中的会话。"
          return this.runPrompt(openid, sid, "继续", [])
        }
        case "retry": {
          const last = this.lastUserText.get(openid)
          if (!last) return "没有可重试的消息。"
          return this.dispatch(openid, last)
        }
        case "model":
          return this.modelCmd(openid, cmd.arg)
        case "thinking":
          return this.thinkingCmd(openid, cmd.arg as "high" | "low")
        case "workdir":
          return this.workdirCmd(openid, cmd.arg)
        case "session":
          return this.sessionCmd(openid, cmd.arg)
        case "help":
          return [
            "opencode-qq 指令:",
            "/new — 重置当前会话",
            "/status — 查看会话状态",
            "/interrupt — 中断当前任务",
            "/continue — 继续当前任务",
            "/retry — 重试上一条消息",
            "/model [序号] — 查看/切换模型",
            "/thinking high|low — 切换思考档位",
            "/workdir [序号] — 查看/切换工作区",
            "/session [序号] — 查看/切换当前工作区会话",
            "/help — 本帮助",
            "其余文本将直接交给 opencode 处理。",
          ].join("\n")
      }
    }

    this.lastUserText.set(openid, text)

    let sessionId = await this.getSessionId(openid)
    if (!sessionId) {
      const title = text.slice(0, 20)
      const created = await this.bridge.sessionCreate(title, this.userWorkdir.get(openid))
      sessionId = created.id
      this.map.set(openid, sessionId)
      this.persist()
      await this.bridge.sessionPrompt(sessionId, "以下用户将通过 QQ 单聊与你对话，回答请精炼。", true)
    }
    return this.runPrompt(openid, sessionId, text, files)
  }

  private async runPrompt(
    openid: string,
    sessionId: string,
    text: string,
    files: Array<{ mime: string; dataUrl: string }>,
  ): Promise<string> {
    const model = this.userModel.get(openid)
    const directory = this.userWorkdir.get(openid)
    const result = await this.bridge.sessionPrompt(sessionId, text, false, files, {
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(directory ? { directory } : {}),
    })
    const out = result.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
    return out || "(无文本回复)"
  }

  private async modelCmd(openid: string, arg?: string): Promise<string> {
    if (!this.ops) return "模型预设未配置（opencode 配置中无可用模型）。"
    const presets = this.ops.listModels()
    if (presets.length === 0) return "模型预设未配置（opencode 配置中无可用模型）。"
    if (arg === undefined) {
      const current = this.currentModelId(openid)
      return [
        "可用模型:",
        ...presets.map(
          (p, i) =>
            `${i + 1}. ${p.label} (${p.id})${p.thinking ? " [思考]" : ""}${p.id === current ? " <- 当前" : ""}`,
        ),
        "切换: /model <序号>",
      ].join("\n")
    }
    const idx = Number(arg) - 1
    const pick = presets[idx]
    if (!pick) return `序号超出范围（1-${presets.length}）。`
    this.userModel.set(openid, {
      providerID: pick.id.split("/")[0] ?? pick.id,
      modelID: pick.id.split("/").slice(1).join("/"),
      label: pick.label,
    })
    return `已切换模型: ${pick.label} (${pick.id})${pick.thinking ? " [思考模式]" : ""}`
  }

  private async thinkingCmd(openid: string, level: "high" | "low"): Promise<string> {
    if (!this.ops) return "模型预设未配置。"
    const presets = this.ops.listModels()
    const pick = level === "high" ? presets.find((p) => p.thinking) : presets.find((p) => !p.thinking)
    if (!pick) return `没有符合「${level === "high" ? "深度思考" : "快速"}」档位的模型预设。`
    this.userModel.set(openid, {
      providerID: pick.id.split("/")[0] ?? pick.id,
      modelID: pick.id.split("/").slice(1).join("/"),
      label: pick.label,
    })
    return `思考档位已切到 ${level === "high" ? "深度" : "快速"}: ${pick.label} (${pick.id})`
  }

  private async workdirCmd(openid: string, arg?: string): Promise<string> {
    if (!this.ops) return "工作区列表不可用。"
    const dirs = await this.ops.listWorkdirs()
    if (dirs.length === 0) return "没有可用的工作区。"
    if (arg === undefined) {
      const current = this.userWorkdir.get(openid)
      return [
        "工作区候选:",
        ...dirs.map((d, i) => `${i + 1}. ${d}${d === current ? " <- 当前" : ""}`),
        "切换: /workdir <序号>（将自动开启新会话）",
      ].join("\n")
    }
    const idx = Number(arg) - 1
    const pick = dirs[idx]
    if (!pick) return `序号超出范围（1-${dirs.length}）。`
    this.userWorkdir.set(openid, pick)
    this.reset(openid)
    return `已切换工作区: ${pick}\n已重置会话，下条消息将在新工作区开启对话。`
  }

  private async sessionCmd(openid: string, arg?: string): Promise<string> {
    if (!this.ops) return "会话列表不可用。"
    const directory = this.userWorkdir.get(openid)
    const sessions = await this.ops.listSessions(directory)
    if (sessions.length === 0) return "当前工作区没有会话。"
    if (arg === undefined) {
      const current = await this.getSessionId(openid)
      return [
        `当前工作区会话（${directory ?? "默认目录"}）:`,
        ...sessions.map((s, i) => `${i + 1}. ${s.title || s.id}${s.id === current ? " <- 当前" : ""}`),
        "切换: /session <序号>",
      ].join("\n")
    }
    const idx = Number(arg) - 1
    const pick = sessions[idx]
    if (!pick) return `序号超出范围（1-${sessions.length}）。`
    this.map.set(openid, pick.id)
    this.persist()
    return `已切换会话: ${pick.title || pick.id}`
  }

  private currentModelId(openid: string): string {
    const chosen = this.userModel.get(openid)
    if (chosen) return `${chosen.providerID}/${chosen.modelID}`
    const def = this.ops?.defaultModel()
    return def ? `${def.providerID}/${def.modelID}` : ""
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
