# 消息互动（按钮键盘）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 opencode-qq 添加 QQ 消息按钮互动——审批按钮化（回调流）、快捷/操作按钮（指令流），含中断/继续/重试。

**架构：** 新增 `keyboard.ts`（按钮构造）与 `interactions.ts`（互动事件处理）两个模块；扩展 `api.ts`（PUT 应答 + event_id 被动消息）、`commands.ts`/`session-manager.ts`（三新指令）、`gateway.ts`（intents 与事件路由）、`index.ts`（挂载与接线）。规格：`docs/superpowers/specs/2026-08-25-keyboard-interaction-design.md`。

**技术栈：** 沿用现有 TypeScript/vitest/ws，无新依赖。

**协议事实（已核实）：** INTERACTION_CREATE intent=1<<26；`d.id`=interaction_id；`d.data.resolved.button_data/button_id`；c2c 含 `user_openid`；PUT `/interactions/{id}` body `{code:0..5}` 无文字字段，3 秒超时，同 id 仅一次；事件 `id` 可作被动消息 `event_id`；keyboard 与 markdown 同消息共存。

---

## 文件结构

```
src/
├── keyboard.ts        # 新增：三类按钮组构造 + button_data 编解码
├── interactions.ts    # 新增：INTERACTION_CREATE 处理与审批代答路由
├── errors.ts          # 修改：新增 KB001-003 / INT001
├── constants.ts       # 修改：INTENT_INTERACTION = 1<<26
├── config.ts          # 修改：keyboard 布尔字段（默认 true）
├── qq/
│   ├── gateway.ts     # 修改：GatewayEvents 增 interaction 回调 + dispatch 路由
│   └── api.ts         # 修改：SendOptions.eventId；putInteraction()
├── commands.ts        # 修改：/interrupt /continue /retry
├── session-manager.ts # 修改：bridge 扩展 + lastUserText + 三指令执行
└── index.ts           # 修改：挂载 keyboard、路由互动事件、/retry 记录
tests/                 # 对应新增 keyboard.test.ts、interactions.test.ts；扩展其余
```

---

### 任务 1：错误码、intents、配置字段

**文件：** 修改 `src/errors.ts`、`src/constants.ts`、`src/config.ts`；测试 `tests/config.test.ts`（追加）

- [ ] **步骤 1.1：errors.ts 追加错误码**

在 `E` 对象末尾（`STREAM_SERVER` 之后）追加：
```ts
  /** ---- 互动 ---- */
  KB_BUILD_FAIL: def("KB001", "keyboard 构造失败，已降级纯文本", undefined, "warn"),
  KB_PUT_FAIL: def("KB002", "互动应答 PUT 失败", "检查 interaction_id 有效性与 3 秒窗口", "warn"),
  KB_UNKNOWN: def("KB003", "未知按钮指令（button_data 无法解析）", undefined, "warn"),
  INT_HANDLE_FAIL: def("INT001", "INTERACTION_CREATE 处理异常", undefined, "error"),
```

- [ ] **步骤 1.2：constants.ts 追加 intent**

```ts
export const INTENT_INTERACTION = 1 << 26
```

- [ ] **步骤 1.3：config.ts 增 keyboard 字段**

`QQConfig` 接口追加 `keyboard: boolean`；`loadConfig` 返回对象追加 `keyboard: file.keyboard ?? true`。

- [ ] **步骤 1.4：测试（追加到 tests/config.test.ts）**

```ts
it("keyboard 默认 true，可显式关闭", async () => {
  process.env.QQ_BOT_APPID = "a"
  process.env.QQ_BOT_APPSECRET = "b"
  expect(loadConfig("/nonexistent")!.keyboard).toBe(true)
})
```

- [ ] **步骤 1.5：运行 `bunx vitest run tests/config.test.ts` → 全绿；全量回归；Commit**

```bash
git add src/errors.ts src/constants.ts src/config.ts tests/config.test.ts
git commit -m "feat: 互动错误码/INTERACTION intent/keyboard 配置"
```

---

### 任务 2：keyboard.ts 按钮构造器

**文件：** 创建 `src/keyboard.ts`；测试 `tests/keyboard.test.ts`

- [ ] **步骤 2.1：编写失败测试**

```ts
import { describe, expect, it } from "vitest"
import { buildAckKeyboard, buildApprovalKeyboard, buildReplyKeyboard } from "../src/keyboard"

describe("keyboard 构造器", () => {
  it("审批键盘：两键回调流，限本人单次", () => {
    const kb = buildApprovalKeyboard(3, "USER_OPENID")
    const btns = kb.content.rows[0].buttons
    expect(btns).toHaveLength(2)
    expect(btns[0].render_data.label).toBe("同意 3")
    expect(btns[0].action).toMatchObject({
      type: 1, data: "approve:3", click_limit: 1,
      permission: { type: 2, specify_user_ids: ["USER_OPENID"] },
    })
    expect(btns[1].render_data.label).toBe("拒绝 3")
    expect(btns[1].action.data).toBe("reject:3")
  })
  it("ack 键盘：单【中断】指令按钮", () => {
    const kb = buildAckKeyboard("USER_OPENID")
    const b = kb.content.rows[0].buttons[0]
    expect(b.render_data.label).toBe("⏹ 中断")
    expect(b.action).toMatchObject({ type: 2, enter: true, data: "/interrupt" })
  })
  it("回复键盘：【新会话】【状态】指令按钮", () => {
    const kb = buildReplyKeyboard("USER_OPENID")
    const labels = kb.content.rows[0].buttons.map((b) => b.render_data.label)
    expect(labels).toEqual(["➕ 新会话", "📊 状态"])
    expect(kb.content.rows[0].buttons[0].action.data).toBe("/new")
    expect(kb.content.rows[0].buttons[1].action.data).toBe("/status")
  })
  it("parseButtonData 编解码往返", () => {
    expect(parseButtonData("approve:3")).toEqual({ action: "approve", seq: 3 })
    expect(parseButtonData("reject:12")).toEqual({ action: "reject", seq: 12 })
    expect(parseButtonData("junk")).toBeNull()
    expect(parseButtonData("approve:x")).toBeNull()
  })
})
```

- [ ] **步骤 2.2：运行 `bunx vitest run tests/keyboard.test.ts` → FAIL（模块不存在）**

- [ ] **步骤 2.3：实现 keyboard.ts**

```ts
export interface QQButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: {
    type: number
    permission: { type: number; specify_role_ids: string[]; specify_user_ids: string[] }
    click_limit: number
    data: string
    enter?: boolean
  }
}
export interface QQKeyboard { content: { rows: Array<{ buttons: QQButton[] }> } }

function button(id: string, label: string, data: string, type: number, openid: string, enter?: boolean): QQButton {
  return {
    id,
    render_data: { label, visited_label: label, style: 0 },
    action: {
      type,
      permission: { type: 2, specify_role_ids: [], specify_user_ids: [openid] },
      click_limit: 1,
      data,
      ...(enter !== undefined ? { enter } : {}),
    },
  }
}

const keyboard = (...buttons: QQButton[]): QQKeyboard => ({ content: { rows: [{ buttons }] } })

export function buildApprovalKeyboard(seq: number, openid: string): QQKeyboard {
  return keyboard(
    button(`approve-${seq}`, `同意 ${seq}`, `approve:${seq}`, 1, openid),
    button(`reject-${seq}`, `拒绝 ${seq}`, `reject:${seq}`, 1, openid),
  )
}
export function buildAckKeyboard(openid: string): QQKeyboard {
  return keyboard(button("ack-interrupt", "⏹ 中断", "/interrupt", 2, openid, true))
}
export function buildReplyKeyboard(openid: string): QQKeyboard {
  return keyboard(
    button("reply-new", "➕ 新会话", "/new", 2, openid, true),
    button("reply-status", "📊 状态", "/status", 2, openid, true),
  )
}
export interface ButtonData { action: "approve" | "reject"; seq: number }
export function parseButtonData(data: string): ButtonData | null {
  const m = /^(approve|reject):(\d+)$/.exec(data)
  return m ? { action: m[1] as "approve" | "reject", seq: Number(m[2]) } : null
}
```

- [ ] **步骤 2.4：运行确认全绿；Commit**

```bash
git add src/keyboard.ts tests/keyboard.test.ts
git commit -m "feat: keyboard 按钮构造器与 button_data 编解码"
```

---

### 任务 3：指令流新指令（/interrupt /continue /retry）

**文件：** 修改 `src/commands.ts`、`src/session-manager.ts`；测试 `tests/commands.test.ts`、`tests/session-manager.test.ts`（追加）

- [ ] **步骤 3.1：commands 失败测试（追加）**

```ts
it("识别 /interrupt /continue /retry", () => {
  expect(parseCommand("/interrupt")).toEqual({ type: "interrupt" })
  expect(parseCommand("/continue")).toEqual({ type: "continue" })
  expect(parseCommand("/retry")).toEqual({ type: "retry" })
})
```

`Command` 类型改为：
```ts
export type Command =
  | { type: "new" } | { type: "status" } | { type: "help" }
  | { type: "interrupt" } | { type: "continue" } | { type: "retry" }
```
正则改为 `/^\/(new|status|help|interrupt|continue|retry)\s*$/i`。

- [ ] **步骤 3.2：session-manager 失败测试（追加）**

mock client 增加 `interrupted: string[]`；bridge 增加可选 `sessionInterrupt?(id: string): Promise<void>`：

```ts
it("/interrupt 调用 bridge.sessionInterrupt 并回复已中断", async () => {
  await sm.dispatch("u1", "hi")
  const sid = (await sm.getSessionId("u1"))!
  const reply = await sm.dispatch("u1", "/interrupt")
  expect(client.interrupted).toEqual([sid])
  expect(reply).toContain("已中断")
})
it("/interrupt 无会话时提示", async () => {
  expect(await sm.dispatch("nobody", "/interrupt")).toContain("暂无进行中的会话")
})
it("/continue 向当前会话追加继续并返回 AI 回复", async () => {
  await sm.dispatch("u1", "hi")
  const n = client.prompted.length
  const reply = await sm.dispatch("u1", "/continue")
  expect(client.prompted[n]).toMatchObject({ id: await sm.getSessionId("u1"), text: "继续" })
  expect(reply.length).toBeGreaterThan(0)
})
it("/retry 重发上一条非指令消息", async () => {
  await sm.dispatch("u1", "第一条")
  const n = client.prompted.length
  await sm.dispatch("u1", "/retry")
  expect(client.prompted[n]).toMatchObject({ text: "第一条" })
})
it("/retry 无历史时提示", async () => {
  expect(await sm.dispatch("fresh", "/retry")).toContain("没有可重试的消息")
})
it("指令消息不记录为 lastUserText", async () => {
  await sm.dispatch("u1", "/status")
  const n = client.prompted.length
  await sm.dispatch("u1", "/retry")
  expect(client.prompted.length).toBe(n) // 未产生新 prompt
})
```

makeClient 的 sessionPrompt 记录追加 `interrupted: [] as string[]`；bridge 实现 `sessionInterrupt(id) { this.interrupted.push(id) }`。

- [ ] **步骤 3.3：实现**

commands.ts 按步骤 3.1 扩展。session-manager.ts：
- `OpencodeBridge` 增加可选 `sessionInterrupt?(id: string): Promise<void>`
- 类内新增 `private lastUserText = new Map<string, string>()`
- dispatch 非指令分支在 prompt 前记录 `this.lastUserText.set(openid, text)`
- 指令 switch 追加：
```ts
case "interrupt": {
  const sid = await this.getSessionId(openid)
  if (!sid) return "暂无进行中的会话"
  await this.bridge.sessionInterrupt?.(sid)
  return "已中断当前任务。"
}
case "continue": {
  const sid = await this.getSessionId(openid)
  if (!sid) return "暂无进行中的会话"
  return this.runPrompt(openid, sid, "继续", [])
}
case "retry": {
  const last = this.lastUserText.get(openid)
  if (!last) return "没有可重试的消息。"
  return this.dispatch(openid, last)
}
```
- 原 prompt 段抽取为私有 `runPrompt(openid, sessionId, text, files)`（含 AI 回复提取），dispatch 非指令路径改调它

- [ ] **步骤 3.4：全量测试绿 + tsc；Commit**

```bash
git add src/commands.ts src/session-manager.ts tests/
git commit -m "feat: /interrupt /continue /retry 指令与会话操作"
```

---

### 任务 4：api.ts 扩展（event_id 被动消息 + 互动应答）

**文件：** 修改 `src/types.ts`、`src/qq/api.ts`；测试 `tests/qq/api.test.ts`（追加）

- [ ] **步骤 4.1：types.ts SendOptions 增 `eventId?: string`（与 msgId 互斥，事件被动回复）**

- [ ] **步骤 4.2：失败测试（追加）**

```ts
it("eventId 被动回复：body 带 event_id 不带 msg_id/msg_seq", async () => {
  const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
  const api = new QQApi({ restBase: "https://api.bot.qq.com", getToken: () => Promise.resolve("TK"), fetchFn: fetchFn as typeof fetch })
  await api.sendC2C("O", "已批准 #3", { eventId: "EVT1" })
  const body = JSON.parse(fetchFn.mock.calls[0][1].body)
  expect(body.event_id).toBe("EVT1")
  expect(body.msg_id).toBeUndefined()
  expect(body.msg_seq).toBeUndefined()
})
it("putInteraction PUT 正确 URL 与 body", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
  const api = new QQApi({ restBase: "https://api.bot.qq.com", getToken: () => Promise.resolve("TK"), fetchFn: fetchFn as typeof fetch })
  await api.putInteraction("IID", 0)
  const [url, init] = fetchFn.mock.calls[0]
  expect(url).toBe("https://api.bot.qq.com/interactions/IID")
  expect(init.method).toBe("PUT")
  expect(JSON.parse(init.body)).toEqual({ code: 0 })
})
it("putInteraction 超时 2.5 秒", async () => {
  vi.useFakeTimers()
  const fetchFn = vi.fn().mockImplementation((_u: string, i?: { signal?: AbortSignal }) => new Promise((_ok, bad) => i?.signal?.addEventListener("abort", () => bad(new Error("timeout")))))
  const api = new QQApi({ restBase: "https://api.bot.qq.com", getToken: () => Promise.resolve("TK"), fetchFn: fetchFn as typeof fetch })
  const p = api.putInteraction("IID", 0)
  const assertion = expect(p).rejects.toThrow(/timeout|abort/i)
  await vi.advanceTimersByTimeAsync(2600)
  await assertion
  vi.useRealTimers()
})
```

- [ ] **步骤 4.3：实现**

api.ts：
- `doSend` 的 body 构造：`options.eventId` 时 `body.event_id = options.eventId`（不写 msg_id/msg_seq）
- 新增：
```ts
async putInteraction(interactionId: string, code: number): Promise<void> {
  const token = await this.opts.getToken()
  const res = await this.fetchFn(`${this.opts.restBase}/interactions/${interactionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(`putInteraction failed: HTTP ${res.status}`)
}
```
- sendC2C 的 429 重试循环对 eventId 分支同样适用（无 msg_seq 逻辑）

- [ ] **步骤 4.4：全绿 + Commit**

```bash
git add src/types.ts src/qq/api.ts tests/qq/api.test.ts
git commit -m "feat: event_id 被动回复与互动应答 API"
```

---

### 任务 5：gateway 路由 INTERACTION_CREATE

**文件：** 修改 `src/types.ts`、`src/qq/gateway.ts`、`src/constants.ts`（如需）；测试 `tests/qq/gateway.test.ts`（追加）

- [ ] **步骤 5.1：types.ts GatewayEvents 增可选回调**

```ts
export interface InteractionEvent {
  id: string
  type: number
  buttonData: string
  buttonId: string
  userOpenid: string
}
export interface GatewayEvents {
  message(msg: IncomingC2CMessage): void
  connected(): void
  disconnected(): void
  interaction?(evt: InteractionEvent): void
}
```

- [ ] **步骤 5.2：失败测试（追加）**

```ts
it("INTERACTION_CREATE 路由到 interaction 回调", async () => {
  const h = await startMockGateway()
  const got = vi.fn()
  const gw = new QQGateway({
    getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
    getToken: () => Promise.resolve("TK"), intents: INTENT,
    connected: vi.fn(), disconnected: vi.fn(), message: vi.fn(), interaction: got,
  })
  gw.start()
  const client = await firstClient(h)
  client.send(JSON.stringify({
    op: 0, s: 7, t: "INTERACTION_CREATE", id: "INT-EVT-1",
    d: { id: "IID-1", type: 11, scene: "c2c", user_openid: "U9",
         data: { type: 11, resolved: { button_data: "approve:3", button_id: "b1" } } },
  }))
  await vi.waitFor(() => expect(got).toHaveBeenCalled())
  expect(got.mock.calls[0][0]).toEqual({ id: "IID-1", type: 11, buttonData: "approve:3", buttonId: "b1", userOpenid: "U9" })
  gw.stop(); h.server.close()
})
```

- [ ] **步骤 5.3：实现**

gateway.ts `handleDispatch` 追加：
```ts
if (t === "INTERACTION_CREATE" && this.opts.interaction) {
  const data = (d.data ?? {}) as { type?: number; resolved?: { button_data?: string; button_id?: string } }
  this.opts.interaction({
    id: String(d.id ?? ""),
    type: Number(data.type ?? d.type ?? 0),
    buttonData: String(data.resolved?.button_data ?? ""),
    buttonId: String(data.resolved?.button_id ?? ""),
    userOpenid: String(d.user_openid ?? ""),
  })
  return
}
```

- [ ] **步骤 5.4：全绿；Commit**

```bash
git add src/types.ts src/qq/gateway.ts tests/qq/gateway.test.ts
git commit -m "feat: 网关路由 INTERACTION_CREATE 事件"
```

---

### 任务 6：interactions.ts 处理器

**文件：** 创建 `src/interactions.ts`；测试 `tests/interactions.test.ts`

- [ ] **步骤 6.1：失败测试**

```ts
import { describe, expect, it, vi } from "vitest"
import { handleInteraction } from "../src/interactions"

function makeDeps(pending: Map<number, { permissionId: string; sessionId: string }>) {
  const puts: Array<{ id: string; code: number }> = []
  const sent: Array<{ openid: string; text: string; eventId: string }> = []
  const approved: Array<{ sessionId: string; permissionId: string; reply: string }> = []
  const deps = {
    put: async (id: string, code: number) => void puts.push({ id, code }),
    confirm: (seq: number) => pending.get(seq),
    respond: async (sessionId: string, permissionId: string, reply: "once" | "reject") =>
      void approved.push({ sessionId, permissionId, reply }),
    sendViaEvent: async (openid: string, eventId: string, text: string) => void sent.push({ openid, eventId, text }),
  }
  return { deps, puts, sent, approved }
}

const evt = (buttonData: string) => ({
  id: "IID", type: 11, buttonData, buttonId: "b", userOpenid: "U1",
})

describe("handleInteraction", () => {
  it("approve：先 PUT 0，代答 once，event_id 回执", async () => {
    const pending = new Map([[3, { permissionId: "p1", sessionId: "s1" }]])
    const { deps, puts, sent, approved } = makeDeps(pending)
    await handleInteraction(evt("approve:3"), deps as never)
    expect(puts[0]).toEqual({ id: "IID", code: 0 })
    expect(approved).toEqual([{ sessionId: "s1", permissionId: "p1", reply: "once" }])
    expect(sent[0]).toMatchObject({ openid: "U1", eventId: "IID", })
    expect(sent[0].text).toContain("已批准 #3")
  })
  it("reject 代答 reject 并回执", async () => {
    const pending = new Map([[5, { permissionId: "p", sessionId: "s" }]])
    const { deps, sent, approved } = makeDeps(pending)
    await handleInteraction(evt("reject:5"), deps as never)
    expect(approved[0].reply).toBe("reject")
    expect(sent[0].text).toContain("已拒绝 #5")
  })
  it("编号不存在：PUT code=3 并提示失效", async () => {
    const { deps, puts, sent } = makeDeps(new Map())
    await handleInteraction(evt("approve:9"), deps as never)
    expect(puts[1]).toEqual({ id: "IID", code: 3 })
    expect(sent[0].text).toContain("#9 已失效")
  })
  it("未知 buttonData：KB003 日志，仅 PUT 0", async () => {
    const { deps, puts, sent } = makeDeps(new Map())
    await handleInteraction(evt("junk"), deps as never)
    expect(puts).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })
})
```

- [ ] **步骤 6.2：实现**

```ts
import { E, qqLog } from "./errors.js"
import { parseButtonData } from "./keyboard.js"

export interface InteractionEvt {
  id: string
  type: number
  buttonData: string
  buttonId: string
  userOpenid: string
}

export interface InteractionDeps {
  put(interactionId: string, code: number): Promise<void>
  confirm(seq: number): { permissionId: string; sessionId: string } | undefined
  respond(sessionId: string, permissionId: string, reply: "once" | "reject"): Promise<void>
  sendViaEvent(openid: string, eventId: string, text: string): Promise<void>
}

export async function handleInteraction(evt: InteractionEvt, deps: InteractionDeps): Promise<void> {
  try {
    await deps.put(evt.id, 0) // 先应答，保 3 秒窗口
    if (evt.type !== 11) return
    const parsed = parseButtonData(evt.buttonData)
    if (!parsed) {
      qqLog("interactions", "KB_UNKNOWN", evt.buttonData)
      return
    }
    const item = deps.confirm(parsed.seq)
    if (!item) {
      await deps.put(evt.id, 3)
      await deps.sendViaEvent(evt.userOpenid, evt.id, `#${parsed.seq} 已失效（已处理或超时）`)
      return
    }
    const reply = parsed.action === "approve" ? "once" : "reject"
    await deps.respond(item.sessionId, item.permissionId, reply)
    await deps.sendViaEvent(
      evt.userOpenid,
      evt.id,
      parsed.action === "approve" ? `已批准 #${parsed.seq} ✓` : `已拒绝 #${parsed.seq}`,
    )
  } catch (e) {
    qqLog("interactions", "INT001", String(e).slice(0, 200))
  }
}
```

- [ ] **步骤 6.3：全绿；Commit**

```bash
git add src/interactions.ts tests/interactions.test.ts
git commit -m "feat: 互动事件处理器（审批代答路由）"
```

---

### 任务 7：index.ts 接线 + 全量验证

**文件：** 修改 `src/index.ts`

- [ ] **步骤 7.1：挂载 keyboard**

- ack：`replyTo(msg.openid, "已收到，处理中…")` 改为带 keyboard——replyTo 增加第 4 参 `keyboard?: unknown`，非空时 `api.sendC2C(openid, chunk, { msgId/eventId, format, keyboard })`；api.ts `doSend` body 追加 `if (options.keyboard) body.keyboard = options.keyboard`
- ack 调用点：`replyTo(msg.openid, "已收到，处理中…", "text", cfg.keyboard ? buildAckKeyboard(msg.openid) : undefined)`
- AI 最终回复：`replyTo(..., format, cfg.keyboard ? buildReplyKeyboard(msg.openid) : undefined)`
- 审批推送（listeners 中 permission.asked）：文本后 `replyTo(openid, approver.render(seq), "text", cfg.keyboard ? buildApprovalKeyboard(seq, openid) : undefined)`
- `SendOptions` 增 `keyboard?: unknown`

- [ ] **步骤 7.2：路由互动事件**

- gateway 构造参数追加 `interaction: (evt) => void handleInteraction(evt, interactionDeps)`（`import { handleInteraction } from "./interactions.js"`）
- interactionDeps：
```ts
const interactionDeps = {
  put: (id, code) => api.putInteraction(id, code),
  confirm: (seq) => approver.confirm(seq),
  respond: (sessionId, permissionId, reply) =>
    input.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: permissionId }, body: { response: reply } }),
  sendViaEvent: (openid, eventId, text) => replyTo(openid, text, "text", undefined, eventId),
}
```
（replyTo 增加第 5 参 `eventId?: string`，优先于 msgId 构造 SendOptions）

- [ ] **步骤 7.3：intents 合并**

gateway 构造 `intents: INTENT_GROUP_AND_C2C | INTENT_INTERACTION`（import 新常量）

- [ ] **步骤 7.4：keyboard 开关**

`cfg.keyboard === false` 时上述所有 keyboard 参数传 `undefined`（构造前判断），行为回退纯文本

- [ ] **步骤 7.5：全量 `bunx vitest run` + `bunx tsc --noEmit`；Commit**

```bash
git add -A
git commit -m "feat: 按钮互动全链路接线（审批回调流 + 指令流挂载）"
```

---

### 任务 8：部署验证与手动验收清单

- [ ] **步骤 8.1：`bun run build`；部署 dist 到三处本地安装点（.config/node_modules 与 cache/packages 两份副本）**
- [ ] **步骤 8.2：用户重启 opencode，沙箱真机验收：**
  1. 触发权限请求 → 消息带【同意 N】【拒绝 N】→ 点击 → QQ 收到「已批准/已拒绝」且 opencode 继续执行
  2. ack 消息带【⏹ 中断】→ 点击 → 任务中止
  3. AI 回复带【➕ 新会话】【📊 状态】→ 点击行为等价文字指令
  4. 无会话时点【中断】→ 收到「暂无进行中的会话」
  5. `keyboard:false` 后重启 → 所有消息无按钮且收发正常
- [ ] **步骤 8.3：Commit（如有微调）**

---

## 自检记录

- 规格覆盖度：§2 intents/两链路→任务 1/4/5；§3.1 审批→任务 2/4/6/7；§3.2 挂载→任务 7；§3.3 三指令→任务 3；§4 配置→任务 1/7；§5 错误码→任务 1/2/6；§6 边界→任务 6（PUT 先行/2.5s）/7（开关）；§7 测试→各任务内嵌 ✓
- 占位符扫描：无 TODO/待定 ✓
- 类型一致性：`InteractionEvt`/`InteractionDeps`/`ButtonData`/`SendOptions.keyboard`/`eventId` 各任务签名一致 ✓
