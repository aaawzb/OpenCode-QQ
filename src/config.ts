import fs from "node:fs"
import { CONFIG_PATH } from "./constants.js"

export interface QQConfig {
  appId: string
  appSecret: string
  /** 默认 true，开发调试走沙箱 */
  sandbox: boolean
  /** openid 白名单，空数组 = 不限制 */
  allowlist: string[]
  events: { toolProgress: boolean }
  /** 可选，"providerID/modelID"，如 anthropic/claude-sonnet-4-5 */
  model?: string
  /** AI 回复是否用 Markdown 格式发送，默认 true */
  markdownReply: boolean
  /** 是否启用流式打字机输出，默认 true */
  streaming: boolean
}

export function loadConfig(path = CONFIG_PATH()): QQConfig | null {
  let file: Partial<QQConfig> = {}
  try {
    file = JSON.parse(fs.readFileSync(path, "utf8"))
  } catch {
    // 文件不存在或非法不致命，凭据可完全来自环境变量
  }
  const appId = process.env.QQ_BOT_APPID ?? file.appId
  const appSecret = process.env.QQ_BOT_APPSECRET ?? file.appSecret
  if (!appId || !appSecret) return null
  return {
    appId,
    appSecret,
    sandbox: file.sandbox ?? false,
    allowlist: file.allowlist ?? [],
    events: { toolProgress: file.events?.toolProgress ?? false },
    model: file.model,
    markdownReply: file.markdownReply ?? true,
    streaming: file.streaming ?? true,
  }
}
