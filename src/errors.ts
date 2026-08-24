/**
 * 统一错误码系统。
 * 日志格式固定为：[opencode-qq][<scope>:<CODE>] 描述 :: 详情 | 排查: 建议
 * 可用 `grep 'opencode-qq'` 一次性捞出全部诊断信息。
 */

export interface ErrSpec {
  /** 稳定错误码，如 AUTH001 */
  code: string
  /** 人读描述 */
  desc: string
  /** 排查建议 */
  hint?: string
  /** 日志级别，默认 error */
  level?: "warn" | "error"
}

const def = (code: string, desc: string, hint?: string, level?: "warn" | "error"): ErrSpec => ({
  code,
  desc,
  ...(hint !== undefined ? { hint } : {}),
  ...(level !== undefined ? { level } : {}),
})

export const E = {
  /** ---- 鉴权 ---- */
  AUTH_HTTP: def("AUTH001", "获取 access_token 失败（HTTP 异常）", "检查网络与 api.bot.qq.com 连通性；若为 IP 白名单问题请到管理端配置公网 IP"),
  AUTH_BODY: def("AUTH002", "token 响应缺少 access_token 字段", "确认 appId/appSecret 与管理端一致、机器人未被封禁"),
  AUTH_RATE: def("AUTH003", "token 获取被频控(err_code=100001)", "降低调用频率，将自动重试", "warn"),
  AUTH_APPID: def("AUTH004", "AppID 无效或机器人状态异常(err_code=100007/10004)", "到开放平台管理端核对 AppID 与机器人状态"),
  AUTH_SECRET: def("AUTH005", "AppSecret 不正确(err_code=100016)", "到开放平台管理端重新复制 AppSecret"),
  AUTH_UNKNOWN: def("AUTH006", "token 获取未知错误"),

  /** ---- 网关 ---- */
  GW_URL_FAIL: def("GW001", "获取网关地址失败", "确认 /gateway 可达且携带 QQBot 鉴权头；IP 白名单需包含本机公网 IP"),
  GW_WS_ERROR: def("GW002", "WebSocket 连接错误", "查看相邻的 close code 日志"),
  GW_CLOSED: def("GW003", "WebSocket 连接关闭", "", "warn"),
  GW_RESUME_REJECTED: def("GW004", "Resume 被拒（Invalid Session），已回退全新 Identify", undefined, "warn"),
  GW_SERVER_RECONNECT: def("GW005", "服务端要求重连（op7 Reconnect）", undefined, "warn"),
  GW_INTENTS_DENIED: def("GW006", "intents 无权限（close 4013/4014）", "到管理端确认机器人已开通单聊场景及对应事件权限"),
  GW_BOT_BANNED: def("GW007", "机器人已下架或封禁（close 4914/4915），停止重连", "到开放平台管理端检查机器人状态"),
  GW_AUTH_FAIL: def("GW008", "网关鉴权失败（close 4010/4001-4005），token 已刷新并回退 Identify", undefined, "warn"),
  GW_HEARTBEAT_TIMEOUT: def("GW009", "心跳超时：超过 2 个周期未收到 op11 ack，判定半开连接，强制重连", undefined, "warn"),

  /** ---- 消息 ---- */
  MSG_SEND_FAIL: def("MSG001", "发送单聊消息失败"),
  MSG_RATE: def("MSG002", "消息频控（HTTP 429 或 err_code=40034100）", "串行队列已限速，持续出现请联系平台提额"),
  SEQ_EXHAUSTED: def("MSG003", "该 msg_id 被动回复额度（4 条）用尽，本次降级为主动消息", "用户可在客户端打开「允许主动发送」；主动消息也有每日上限", "warn"),

  /** ---- 流式 ---- */
  STREAM_BEGIN_FAIL: def("STREAM001", "流式首片发送失败，整条流作废并回落普通回复"),
  STREAM_PREFIX: def("STREAM002", "流式前缀不一致（err_code=40007），回落普通回复", undefined, "warn"),
  STREAM_RATE: def("STREAM003", "流式限频（err_code=50002），退避后重试一次", undefined, "warn"),
  STREAM_SERVER: def("STREAM004", "流式服务端内部错误（err_code=50001），回落普通回复", undefined, "warn"),
} satisfies Record<string, ErrSpec>

export type ErrKey = keyof typeof E

export function specOf(key: ErrKey): ErrSpec {
  return E[key]
}

/**
 * 输出统一格式的错误日志。所有模块的诊断信息都应走这里，
 * 保证 `grep opencode-qq` 能捞到完整故障链。
 */
export function qqLog(scope: string, key: ErrKey, detail?: unknown): void {
  const s = E[key]
  const d = detail === undefined || detail === "" ? "" : " :: " + truncate(String(detail), 240)
  const line = `[opencode-qq][${scope}:${s.code}] ${s.desc}${d}${s.hint ? " | 排查: " + s.hint : ""}`
  if (s.level === "warn") console.warn(line)
  else console.error(line)
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…"
}
