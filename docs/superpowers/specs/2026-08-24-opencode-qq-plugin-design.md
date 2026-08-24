# opencode-qq：连接 QQ 机器人的 opencode 插件 — 设计文档

日期：2026-08-24
状态：已获用户批准的设计，待实现

## 1. 背景与目标

做一个发布到 npm 的 opencode 插件，让 opencode 桌面版通过 QQ 机器人开放平台（https://bot.q.qq.com/wiki/）与 QQ 单聊双向打通：

- **下行**：用户在 QQ 单聊里发消息 → 插件驱动 opencode 会话处理 → AI 回复发回 QQ。opencode 充当机器人的"大脑"。
- **上行**：opencode 的关键事件（任务完成、出错、权限请求等）主动推送到 QQ。
- **远程审批**：opencode 发出权限请求时，用户直接在 QQ 里回复"同意/拒绝"，插件代为应答。

### 需求决策记录

| 决策点 | 结论 |
|--------|------|
| 数据流向 | 双向（QQ ↔ opencode） |
| QQ 场景 | 仅 C2C 单聊，不支持频道/群 |
| 用户限制 | 默认不限制；保留默认关闭的 openid 白名单配置项 |
| 会话映射 | 每个 QQ 用户对应一个长期 opencode 会话，`/new` 重置 |
| 推送事件 | session.idle、session.error、permission.asked 必开；工具进度可选（默认关） |
| 权限审批 | 支持 QQ 回复审批（同意/拒绝） |
| 分发 | npm 包发布，`opencode.json` 一行接入 |

### 前置条件（用户侧）

1. 在 QQ 开放平台注册（个人或企业主体）并创建机器人，获得 AppID / Token / AppSecret。
2. 在开放平台配置沙箱单聊账号用于开发调试。
3. 注意：新机器人正式环境默认启用 IP 白名单，提审上线前需在管理端配置公网 IP；沙箱环境不受影响。

## 2. 总体架构

采用**方案 A：纯插件，进程内直连**。单个 TypeScript npm 包作为 opencode 插件运行于 opencode 进程内，向 QQ 官方 WSS 网关发起出站 WebSocket 连接接收事件，无需公网 IP 与备案域名。

> 备选方案 B（独立网关服务 + 薄插件桥接）因部署复杂被否决；方案 C（WebHook 回调）因桌面场景需内网穿透与备案域名被排除。

```
QQ 客户端(单聊) ⇄ QQ开放平台 ⇄ [WSS出站+REST] qq-gateway（opencode 进程内）
                                      ⇅ 内存总线
                            session-manager ⇄ opencode SDK client
                                      ⇅
                            event-pusher（hooks 监听 → 节流 → QQ）
                            approver（权限请求 ↔ QQ 回复配对代答）
```

### 模块职责

| 模块 | 职责 | 对外接口 |
|------|------|----------|
| `qq-gateway` | 认证、WSS 连接维护、心跳、断线重连、REST 发消息、频控 | `onMessage(cb)`、`sendC2C()` |
| `session-manager` | openid ↔ opencode session 映射、长期会话维持、指令处理 | `dispatch(openid, text)` |
| `event-pusher` | 监听 opencode 钩子并节流推送 QQ（仅限本插件创建的会话） | 注册在插件 hooks |
| `approver` | 权限请求编号分配、QQ 回复解析、SDK 代答 | `pending.get(seq)` |

## 3. QQ 接入层（qq-gateway）

### 认证

- 用 AppID + AppSecret `POST https://bots.qq.com/app/getAppAccessToken` 换取 access_token。
- token 到期前 60 秒自动刷新；token 只存内存，不落盘。

### WSS 连接

- 拉取网关地址后建立**出站** WSS 连接，首包 Identify（token + intents：C2C 事件位）。
- 心跳按服务端下发的 `heartbeat_interval` 执行。
- 断线指数退避重连（1s 起，倍增，60s 封顶）；优先带 session_id Resume，Resume 失败则重新 Identify。

### 收发消息（C2C）

- **收**：订阅 `C2C_MESSAGE_CREATE`，提取 `openid`、`content`、`msg_id`、`timestamp`。
- **发**：`POST /v2/users/{openid}/messages`，文本 `msg_type=0`。
- **被动回复窗口策略**：
  1. 收到消息立即回执"已收到，处理中…"（必在窗口内）；
  2. 任务完成后若仍在窗口内则继续被动回复（引用原 `msg_id`）；超窗则尝试主动消息，无主动推送权限时降级为记日志，并在该用户下次来消息时附带说明。
- **频控**：发送队列串行化；遇 429 按 Retry-After 退避重试（最多 3 次）。

### 环境切换

- 配置 `sandbox: true/false` 切换沙箱/正式环境地址（沙箱：`https://sandbox.api.sgroup.qq.com`；正式：`https://api.sgroup.qq.com`）。开发调试默认沙箱。

## 4. 会话管理与指令（session-manager）

- 映射表 `openid → sessionID` 持久化到 `~/.config/opencode/opencode-qq-sessions.json`，opencode 重启后会话延续。
- 该用户首条消息：`client.session.create()` 创建会话，标题取消息前 20 字；后续消息通过 SDK 向既有会话追加 prompt。
- AI 回复完成后取最新 assistant 文本发回 QQ；超过 QQ 单条上限（约 2000 字节）自动截断分条发送。

### 内置指令（`/` 开头拦截，不进 AI）

| 指令 | 行为 |
|------|------|
| `/new` | 清除当前映射，下次消息新建会话 |
| `/status` | 回复当前会话 ID、空闲状态、待审批数 |
| `/help` | 输出指令说明 |

## 5. 事件推送与远程审批

### event-pusher

仅监听**本插件创建的会话**的事件，避免干扰桌面端其他会话：

| 事件 | 行为 | 开关默认值 |
|------|------|-----------|
| `session.idle` | "✅ 任务完成" + 最后回复摘要 | 开 |
| `session.error` | "❌ 出错" + 错误摘要 | 开 |
| `permission.asked` | 审批请求文本（见下） | 开 |
| 工具执行进度 | 按会话聚合，每 60s 至多一条 | 关 |

### approver（远程审批）

- `permission.asked` 触发时分配自增编号，推送：`[权限请求 #3] 执行命令: npm test\n回复"同意 3"或"拒绝 3"`。
- 用户回复经正则解析匹配待审请求 → 插件调用 SDK 应答对应 permission → 回执"已批准 #3"/"已拒绝 #3"。
- 待审请求存内存 Map（`#编号 → permissionID`），10 分钟超时自动清理，`/new` 时一并清空。

## 6. 配置与安全

配置优先级：环境变量 > 配置文件 `~/.config/opencode/opencode-qq.json`。

```json
{
  "appId": "xxx",
  "appSecret": "xxx",
  "sandbox": true,
  "allowlist": [],
  "events": { "toolProgress": false }
}
```

- 敏感信息可用 `QQ_BOT_APPID` / `QQ_BOT_APPSECRET` 环境变量替代文件配置；文档强调不得把 secret 提交进仓库。
- `allowlist`：openid 数组；空数组 = 不限制（当前决策），非空则只处理白名单用户的消息。
- 缺少必填配置时插件**静默禁用**并写日志，绝不影响 opencode 正常启动。

## 7. 错误处理

- WSS 断连期间产生的 opencode 事件进入队列，重连成功后补发。
- REST 失败：429 按 Retry-After 退避重试 3 次；其余错误记日志并向对应用户回复失败提示。
- 全部异常在插件内部消化，不上抛——插件故障不能拖垮 opencode 本体。

## 8. 测试策略

- **单元测试**（vitest）：指令解析、会话映射持久化、审批编号配对、节流聚合逻辑。
- **集成测试**：本地 mock QQ 网关（WebSocket 服务模拟事件下发、断言发送报文格式）。
- **手动验收**：沙箱真机单聊全流程——普通对话、`/new`、`/status`、权限远程审批、断网重连续传。

## 9. 项目形态

- TypeScript + Bun 开发，构建为标准 opencode 插件 npm 包，包名 `opencode-qq`。
- README 包含完整接入指引：注册开放平台 → 创建机器人 → 配置沙箱 → 安装插件 → 填写凭据。
- 仓库根目录即插件源码；`docs/superpowers/specs/` 存放本设计文档。

## 10. 范围外（明确不做）

- QQ 频道、群聊场景。
- 图片/富媒体消息收发（首版纯文本）。
- WebHook 回调模式。
- 多机器人实例。
