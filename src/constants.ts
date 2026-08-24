export const TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken"
export const REST_BASE_PROD = "https://api.bot.qq.com"
export const REST_BASE_SANDBOX = "https://sandbox.api.sgroup.qq.com"
export const INTENT_GROUP_AND_C2C = 1 << 25
export const PASSIVE_WINDOW_MS = 60 * 60 * 1000 // 单聊被动窗口 60 分钟
export const MAX_REPLIES_PER_MSG_ID = 4 // 每条收到的消息最多被动回复次数（ack+结果 占 2 次）
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
export const CONFIG_PATH = () =>
  `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/opencode/opencode-qq.json`
export const SESSIONS_PATH = () =>
  `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/opencode/opencode-qq-sessions.json`
export const GATEWAY_PATH = "/gateway"
