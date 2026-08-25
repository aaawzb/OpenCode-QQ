# 消息互动（按钮键盘）功能 — 设计文档

日期：2026-08-25
状态：已获用户批准的设计，待实现
父项目：opencode-qq（规格见 2026-08-24-opencode-qq-plugin-design.md）

## 1. 背景与目标

为 opencode-qq 插件添加 QQ 消息互动能力（官方文档：server-inter/message/trans）。用户点击消息底部按钮即可完成审批、快捷指令与任务操作，替代部分文字交互。

### 需求决策记录

| 决策点 | 结论 |
|--------|------|
| 按钮场景 | 三场景全要：审批按钮化、快捷指令面板、回复操作按钮 |
| 挂载策略 | 分工挂载：ack 回执挂【中断】，AI 最终回复挂【新会话】【状态】；指令回复不挂 |
| 操作按钮 | 中断 / 继续 / 重试 三个都要 |
| 交互架构 | 方案 C 混合流：审批走回调流，快捷指令与操作按钮走指令流 |

### 协议事实（已核实）

- 事件 `INTERACTION_CREATE`，intent `INTERACTION = 1<<26`；type=11 为消息按钮点击
- 事件 `d.id` 即 interaction_id（无前缀）；`d.data.resolved.button_data` 为按钮 data 字段值；c2c 场景含 `user_openid`
- 应答：`PUT /interactions/{interaction_id}`，body `{code}`（0 成功/1 失败/2 频繁/3 重复/4 无权限/5 仅管理员），**无文字字段**；指令回调场景 **3 秒超时**，同一 id 仅可应答一次
- 事件 `id` 亦可用作被动消息的 `event_id`（消息概述页：被动消息-响应事件）
- 按钮 action：`type`（1 回调 / 2 指令）、`enter`（指令流自动发送）、`permission`（可指定用户）、`click_limit`、`data`
- keyboard 与 markdown 可同消息共存：`{ msg_type:2, markdown:{...}, keyboard:{...} }`

## 2. 交互架构（方案 C 混合流）

**intents 扩展**：`GROUP_AND_C2C_EVENT (1<<25) | INTERACTION (1<<26)`

**两条链路**：

1. **回调流（审批按钮）**：点击 → `INTERACTION_CREATE` → 立即 `PUT code=0`（先应答后动作，保 3 秒）→ 解析 `button_data`（`approve:seq` / `reject:seq`）→ 经 approver 代答 permission → 以事件 `id` 为 `event_id` 发被动消息「已批准 #N ✓」/「已拒绝 #N」
2. **指令流（快捷 + 操作）**：点击 → 客户端自动发送 `data` 作为用户消息 → 进现有指令解析器 → 正常被动回复

**新模块**：

| 模块 | 职责 | 接口 |
|------|------|------|
| `src/keyboard.ts` | 三类按钮组构造、button_data 编解码 | `buildApprovalKeyboard(seq)`、`buildAckKeyboard()`、`buildReplyKeyboard()` |
| `src/interactions.ts` | INTERACTION_CREATE 处理、PUT 应答、审批代答路由 | `handleInteraction(evt, deps)` |

## 3. 三场景行为定义

### 3.1 审批按钮化（回调流）

- `permission.asked` 推送改为：文本 `[权限请求 #N] <摘要>` + keyboard【同意 N】【拒绝 N】
- 按钮属性：`type=1`、`click_limit=1`、`permission.type=2` 且 `specify_user_ids=[该用户 openid]`、data=`approve:N` / `reject:N`
- 点击处理：先 `PUT code=0`；再查 approver——命中则代答（`once`/`reject`）并以 event_id 发被动消息「已批准 #N ✓」/「已拒绝 #N」；编号不存在/超时 → `PUT code=3`（重复操作）+ event_id 消息「#N 已失效」
- 文字「同意 N / 拒绝 N」双通道保留，行为不变
- 10 分钟超时清理逻辑不变

### 3.2 分工挂载（指令流）

- ack 回执（「已收到，处理中…」）→ 挂【⏹ 中断】（data=`/interrupt`）
- AI 最终回复 → 挂【➕ 新会话】（`/new`）、【📊 状态】（`/status`）
- 指令类回复（/help 等）与错误提示 → 不挂按钮
- 按钮通用属性：`type=2`、`enter=true`、`permission` 限本人、`click_limit=1`

### 3.3 操作三键（指令流，新指令）

| 指令 | 行为 |
|------|------|
| `/interrupt` | `client.session.interrupt({path:{id}})` 中断该用户当前会话 → 回复「已中断」；无会话 → 「暂无进行中的会话」 |
| `/continue` | 向当前会话追加 prompt「继续」→ 走正常 AI 回复流程；无会话 → 提示 |
| `/retry` | 重发该用户最近一条非指令消息（内存记录 lastUserText，随实例生命周期）→ 正常回复流程；无记录 → 「没有可重试的消息」 |

## 4. 配置

`opencode-qq.json` 新增：

```json
{ "keyboard": true }
```

- 默认 `true`；`false` 时完全不发 keyboard 字段，行为与 v0.1.7 一致
- keyboard 构造异常时降级纯文本发送并记 `KB001`，不阻塞主链路

## 5. 错误码新增（errors.ts）

| 码 | 含义 |
|----|------|
| KB001 | keyboard 构造失败（降级纯文本） |
| KB002 | 互动应答 PUT 失败（非 2xx/超时） |
| KB003 | 未知按钮指令（button_data 无法解析） |
| INT001 | INTERACTION_CREATE 处理异常 |

## 6. 兼容性与边界

- intents 常量改为 `1<<25 | 1<<26`（constants.ts 单点修改）
- INTERACTION_CREATE 处理器**先 PUT 后动作**，PUT 设 2.5 秒 AbortSignal 超时，绝不越过 3 秒窗口
- 事件去重天然覆盖互动事件（`pkt.id` 已有机制）
- 回调流与文字审批双通道并存；`/new` 清空待审批逻辑不变
- `/retry` 的 lastUserText 不含指令消息；每用户独立记录
- 指令流点击产生的消息与手输指令完全同构，不新增解析路径（仅 commands.ts 增加三个新指令）

## 7. 测试策略

- **单元**：keyboard 三类构造器快照/结构断言；button_data 编解码；`/interrupt` `/continue` `/retry` 解析与 bridge 行为（含无会话分支）；SingleInstanceLock 不受影响回归
- **集成**：mock 网关注入 INTERACTION_CREATE（type=11，含 button_data）→ 断言 PUT 报文（URL/body）与代答调用次序；重复事件去重；编号失效路径
- **手动验收**：沙箱真机——审批两键点击、三操作键、无会话点操作键、keyboard:false 回退、文字审批双通道并存

## 8. 范围外

- 群聊/频道场景按钮
- type=12 快捷菜单（管理端配置类，非代码能力）
- 消息反馈（点赞点踩）、故事集、切换模型等互动类型的业务化处理（事件到达仅记日志）
- 模板 keyboard（custom_template_id）

## 9. 追加需求：菜单面板动作路由 + 模型/工作区/会话切换（2026-08-25 补充）

### 9.1 模型预设自动扫描（presets.ts）

- 读 opencode 配置（`~/.config/opencode/opencode.jsonc`，JSONC 宽松解析：去注释去尾逗号）的 `provider.*.models`，排除 `disabled_providers`
- 生成预设：`{ id: "provider/modelID", label: models 里的 name 或 modelID, thinking: models[m].reasoning === true }`
- 工作区列表：查询 opencode 服务器 `GET /session`，按 `directory` 去重（历史项目即工作区候选）

### 9.2 每用户状态与指令

| 指令 | 行为 |
|------|------|
| `/model` | 列出预设（序号+label+thinking 标记+当前项标注） |
| `/model <序号>` | 切换该用户的当前模型（后续 prompt 的 model 参数生效），回复确认 |
| `/thinking high` | 切到第一个 `thinking:true` 的预设；`low` → 第一个非 thinking 预设 |
| `/workdir` | 列出工作区候选 + 当前标注 |
| `/workdir <序号>` | 切换该用户工作区 + 自动重置会话（新会话在目标目录创建） |
| `/session` | 列出**当前工作区**下的会话（server API 按 directory 过滤，标题+序号+当前标注） |
| `/session <序号>` | 将该用户绑定切换到所选会话（后续消息进该会话） |

- 模型选择、工作区选择为**每用户独立**状态（内存）
- prompt/create 调用均携带该用户当前 `directory`

### 9.3 菜单面板（管理端配置 + type=12 回调路由）

- 菜单项在开放平台管理端配置（用户手动操作）；点击推 `INTERACTION_CREATE type=12`（含 `feature_id`）
- 配置文件新增 `menus: [{ featureId: string, action: string }]`，action 形如 `model:N` / `thinking:high` / `workdir:N` / `new` / `session:N`
- interactions.ts 扩展：type=12 → 查 menus 映射 → 路由到对应动作（复用指令执行通道）；无映射 → KB003 日志

### 9.4 范围外追加

- 管理端菜单项的配置操作本身（用户在开放平台页面完成）
- opencode 无原生思考档位开关——思考档位经由模型预设（provider models 的 reasoning 标志）实现
