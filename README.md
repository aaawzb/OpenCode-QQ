# opencode-qq

把 [opencode](https://opencode.ai) 接入 QQ 单聊的官方插件：在 QQ 里和 AI 对话，驱动 opencode 干活。

## 功能

- **对话驱动 opencode**：QQ 单聊消息直达 opencode 会话，AI 回复发回 QQ；每个 QQ 用户对应一个长期会话，重启后延续。
- **Markdown 回复**：AI 回复默认以 Markdown 格式发送，可配置降级为纯文本。
- **流式打字机输出**：长回复通过 QQ stream_messages API 边生成边更新，打字机效果呈现。
- **图片理解**：单聊里发的图片会转交给 opencode 多模态处理，让 AI 看图回答。
- **任务完成 / 出错推送**：opencode 会话完成（✅）或出错（❌）时主动推送到 QQ，断线期间的事件重连后补发。
- **QQ 远程审批权限**：opencode 发出权限请求时直接在 QQ 里回复"同意 / 拒绝"，无需回到电脑前。
- **内置指令**：`/new` 重置会话、`/status` 查看状态、`/help` 帮助。

## 前置条件

1. 在 [QQ 开放平台](https://q.qq.com/) 注册账号（个人或企业主体均可），并完成机器人创建，拿到 **AppID** 与 **AppSecret**。
2. 在开放平台管理端为机器人配置 **沙箱单聊账号**（用于开发调试阶段与自己互加好友单聊）。
3. 注意：新机器人在**正式环境**默认启用 IP 白名单，提审上线前需在管理端填写服务器公网 IP；沙箱环境不受影响。本插件从本地发起出站 WebSocket 连接，填你本机的公网出口 IP 即可。

## 安装

在项目的 `opencode.json` 中加入一行：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qq"]
}
```

重启 opencode 后插件自动生效；缺少凭据时插件会静默禁用并写日志，不影响 opencode 正常启动。

## 配置

凭据有两种提供方式，环境变量优先于配置文件。

### 方式一：扫码绑定（推荐）

```bash
npx opencode-qq-setup
```

按提示用手机 QQ 扫码授权后，凭据自动写入 `~/.config/opencode/opencode-qq.json`。需要 v0.1.0 及以上版本的包。

### 方式二：手写配置文件

创建 `~/.config/opencode/opencode-qq.json`：

```json
{
  "appId": "你的AppID",
  "appSecret": "你的AppSecret",
  "sandbox": false,
  "allowlist": [],
  "model": "anthropic/claude-sonnet-4-5",
  "markdownReply": true,
  "streaming": true,
  "events": { "toolProgress": false }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `appId` / `appSecret` | 必填 | 开放平台机器人凭据 |
| `sandbox` | `false` | 默认走正式环境（快速创建的机器人本就只能与管理员 QQ 单聊，等价天然白名单）；需要沙箱调试时改 `true` 并在管理端配置沙箱单聊账号 |
| `allowlist` | `[]` | openid 白名单，空数组 = 不限制；非空则仅处理白名单用户的消息 |
| `model` | 无 | 覆盖模型，格式 `providerID/modelID`；不填则用 opencode 全局默认模型，两者都没有时对话会报错 |
| `markdownReply` | `true` | AI 回复是否用 Markdown 发送 |
| `streaming` | `true` | 是否启用流式打字机输出 |
| `events.toolProgress` | `false` | 是否推送工具执行进度（按会话聚合，每 60 秒至多一条） |

### 方式三：环境变量

不想落盘 secret 时，可用环境变量替代文件中的对应字段：

```bash
export QQ_BOT_APPID=你的AppID
export QQ_BOT_APPSECRET=你的AppSecret
```

> ⚠️ 安全提示：`appSecret` 等同于机器人密码，切勿提交到仓库或分享；建议优先使用环境变量或扫码绑定。

## 使用

1. 用配置好的沙箱（或正式）QQ 号**添加机器人为好友**。
2. 在单聊中发送任意文本即可开始对话，也可以直接发图片让 AI 看。
3. 收到"已收到，处理中…"回执后稍候，AI 回复会自动送达。

### 指令

| 指令 | 行为 |
|------|------|
| `/new` | 重置当前会话，下次消息开启新对话 |
| `/status` | 查看当前会话 ID 与状态 |
| `/help` | 输出指令说明 |

其余以 `/` 开头的未知文本会原样交给 opencode 处理。

### 远程审批

当 opencode 需要权限（如执行命令、写文件）时，QQ 会收到编号请求：

```
[权限请求 #1] 执行命令: npm test
回复"同意 1"批准本次，回复"拒绝 1"拒绝。
```

直接回复 `同意 1` 或 `拒绝 1` 即可代为应答，插件回执"已批准 #1"。待审请求 10 分钟超时，`/new` 重置会话时一并清空。

## 注意事项

- **被动消息窗口**：QQ 单聊被动回复窗口为收到消息后 60 分钟，且每条收到的消息最多回复 4 条。超窗后的推送（如长时间任务的完成通知）会尝试走主动消息，无权限时记日志并在该用户下次来消息时附带说明。
- **主动消息限制**：主动消息受平台频控与额度约束，日常使用请以先发消息触发对话为主。
- **沙箱与正式切换**：默认即正式环境（`"sandbox": false`）。快速创建通道的机器人只能与管理员 QQ 单聊，天然受限，无需沙箱；若走完整入驻流程需要沙箱调试，改 `"sandbox": true` 并在管理端配置沙箱单聊账号。机器人提审上线后需在管理端配置 IP 白名单。
- **流式输出语义**：流式通道每一片都是当前正文的**全量快照**（客户端整体替换显示），而非追加式增量；流式发送失败时自动回落为普通被动回复，不会丢内容。

## 开发

仓库即插件源码，使用 Bun 管理：

```bash
bun install      # 安装依赖
bun test         # 运行测试
bun run build    # 构建到 dist/
```

设计文档见 `docs/superpowers/specs/2026-08-24-opencode-qq-plugin-design.md`。

## License

MIT
