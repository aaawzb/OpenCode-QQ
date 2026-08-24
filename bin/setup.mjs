#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const configDir = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "opencode",
)
const configPath = path.join(configDir, "opencode-qq.json")

let connector
try {
  connector = await import("@tencent-connect/qqbot-connector")
} catch {
  console.error("缺少依赖 @tencent-connect/qqbot-connector")
  console.error("请先执行: npm install -g @tencent-connect/qqbot-connector")
  process.exit(1)
}

console.log("请使用手机 QQ 扫描终端二维码完成绑定…")
const credsList = await connector.qrConnect({ source: "opencode-qq" })
const creds = credsList[0]
if (!creds) {
  console.error("扫码未返回凭据")
  process.exit(1)
}

let existingRaw = "{}"
try {
  existingRaw = fs.readFileSync(configPath, "utf8")
} catch {
  /* 无配置文件视为空 */
}

const { mergeCredentials } = await import("../dist/setup-core.js")
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(configPath, mergeCredentials(existingRaw, creds))
console.log(`凭据已写入 ${configPath}`)
