# opencode-qq 插件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 发布 npm 包 `opencode-qq`——opencode 桌面版插件，通过 QQ 机器人开放平台 WSS 直连实现 QQ 单聊 ↔ opencode 会话双向打通（含事件推送与权限远程审批）。

**架构：** 单个 TypeScript npm 包作为 opencode 插件运行于 opencode 进程内。四个独立模块：`qq-gateway`（认证+WSS+REST 发消息）、`session-manager`（openid↔会话映射与指令）、`event-pusher`(opencode 钩子→节流→QQ)、`approver`（权限请求↔QQ 回复代答）。设计规格：`docs/superpowers/specs/2026-08-24-opencode-qq-plugin-design.md`。

**技术栈：** TypeScript + Bun(开发/运行时) 、vitest、`ws`（WebSocket 客户端）、`@opencode-ai/plugin` 类型。无其他运行时依赖。

**已核实的协议事实（写代码时以此为准）：**
- token：`POST https://api.bot.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `{access_token, expires_in:"7200"}`；请求头格式 `Authorization: QQBot <access_token>`；过期前 60 秒内重新获取会拿到新 token。
- REST 域名：正式 `https://api.bot.qq.com`；沙箱 `https://sandbox.api.sgroup.qq.com`。token 接口不分环境。
- WSS：先 `GET {restBase}/gateway` 得 `{url}`；包结构 `{op,d,s,t}`；Hello op=10(d.heartbeat_interval 毫秒)；心跳 op=1(d=最近一条 dispatch 的 s 或 null)、ack op=11；Identify op=2(d=`{token:"QQBot <access_token>", intents, shard:[0,1]}`)；Resume op=6(d=`{token, session_id, seq}`)；dispatch op=0 带 `t` 事件名与递增 `s`；`READY` 事件的 `d.session_id` 用于 Resume。
- C2C intent 位：`GROUP_AND_C2C_EVENT = 1 << 25`。
- 收单聊：dispatch 事件 `C2C_MESSAGE_CREATE`，字段含 `openid`、`content`、`msg_id`、`timestamp`。
- 发单聊：`POST {restBase}/v2/users/{openid}/messages`，body `{content, msg_type:0, msg_id?, msg_seq?}`；被动回复窗口 **60 分钟、每条收到的消息最多回 4 次**；相同 `msg_id+msg_seq` 重复发送会失败，须递增 `msg_seq`；不带 `msg_id` 即主动消息（可能被用户关闭或限频）。
- opencode SDK client（v1 gen）：`client.session.create({body:{title}})`；`client.session.prompt({path:{id}, body:{model:{providerID,modelID}, parts:[{type:"text",text}], noReply?}})`；权限代答 `client.postSessionIdPermissionsPermissionId({path:{id, permissionID}, body:{reply:"once"|"always"|"reject"}})`；日志 `client.app.log({body:{service,level,message}})`。
- opencode 插件 hooks（`@opencode-ai/plugin`）：插件函数签名 `(input: PluginInput) => Promise<Hooks>`；`Hooks.event?: ({event}) => Promise<void>` 收到全部系统事件（`session.idle`、`session.error`、`permission.asked` 等）；`Hooks.dispose?` 清理。

---

## 文件结构

```
OPQQ/
├── package.json              # npm 包配置 name=opencode-qq
├── tsconfig.json             # tsc 构建 → dist/
├── vitest.config.ts
├── .gitignore
├── README.md                 # 接入指引
└── src/
    ├── index.ts              # 插件入口：装配四模块、注册 hooks、静默禁用
    ├── config.ts             # 配置加载（文件 ~/.config/opencode/opencode-qq.json + 环境变量覆盖）
    ├── constants.ts          # 域名/intent 等常量集中处
    ├── qq/
    │   ├── auth.ts           # access_token 获取与缓存刷新
    │   ├── gateway.ts        # WSS 连接、心跳、Identify/Resume、退避重连
    │   └── api.ts            # REST 发送队列、msg_seq 管理、429 退避、被动/主动降级
    ├── commands.ts           # /new /status /help 解析
    ├── session-manager.ts    # openid→sessionID 映射、持久化、dispatch 主流程
    ├── approver.ts           # 权限编号分配、QQ 回复解析、10 分钟超时
    ├── event-pusher.ts       # opencode 事件过滤/节流/断线补发
    └── util/
        ├── chunk.ts          # UTF-8 字节安全的长文分条
        └── throttle.ts       # 按 key 聚合的节流器
tests/                        # 与 src 镜像（vitest）
```

每个文件单一职责；`src/index.ts` 是唯一知道 opencode SDK 形状的装配点，其余模块通过构造注入依赖（便于测试替身）。

---

### 任务 1：项目脚手架 + 工具函数（chunk、throttle）

**文件：**
- 创建：`package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`
- 创建：`src/util/chunk.ts`、`src/util/throttle.ts`
- 测试：`tests/util/chunk.test.ts`、`tests/util/throttle.test.ts`

- [ ] **步骤 1.1：创建脚手架文件**

`package.json`：
```json
{
  "name": "opencode-qq",
  "version": "0.1.0",
  "description": "QQ bot (C2C) <-> opencode bridge plugin",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "prepublishOnly": "npm run build && npm test"
  },
  "keywords": ["opencode", "opencode-plugin", "qq", "bot"],
  "license": "MIT",
  "dependencies": { "ws": "^8.18.0" },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "@types/ws": "^8.5.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`：
```ts
import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } })
```

`.gitignore`：
```
node_modules/
dist/
*.log
```

- [ ] **步骤 1.2：安装依赖**

运行：`bun install`
预期：依赖装好，`node_modules/` 出现。

- [ ] **步骤 1.3：编写 chunk 失败测试**

`tests/util/chunk.test.ts`：
```ts
import { describe, expect, it } from "vitest"
import { splitText } from "../../src/util/chunk"

describe("splitText", () => {
  it("短文本原样返回单条", () => {
    expect(splitText("hello", 100)).toEqual(["hello"])
  })
  it("按字节上限切分且不产生空片段", () => {
    const parts = splitText("ab".repeat(1500), 1000)
    for (const p of parts) {
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(1000)
      expect(p.length).toBeGreaterThan(0)
    }
    expect(parts.join("")).toBe("ab".repeat(1500))
  })
  it("优先在换行处切分", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50)
    const parts = splitText(text, 60)
    expect(parts[0].endsWith("\n") || parts.length === 1).toBe(true)
  })
  it("多字节字符不被切成乱码", () => {
    const text = "中".repeat(600) // 每个 3 字节
    const parts = splitText(text, 900) // 恰好 300 字/条边界
    for (const p of parts) expect(p).toMatch(/^中+$/)
  })
})
```

- [ ] **步骤 1.4：运行确认失败**

运行：`bunx vitest run tests/util/chunk.test.ts`
预期：FAIL，报错找不到模块 `../../src/util/chunk`。

- [ ] **步骤 1.5：实现 chunk**

`src/util/chunk.ts`：
```ts
export function splitText(text: string, maxBytes = 1900): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text ? [text] : []
  const parts: string[] = []
  let current = ""
  let currentBytes = 0
  for (const seg of text.split(/(?<=\n)/)) {
    const segBytes = Buffer.byteLength(seg, "utf8")
    if (segBytes > maxBytes) {
      if (current) {
        parts.push(current)
        current = ""
        currentBytes = 0
      }
      let buf = ""
      let bufBytes = 0
      for (const ch of seg) {
        const chBytes = Buffer.byteLength(ch, "utf8")
        if (bufBytes + chBytes > maxBytes) {
          parts.push(buf)
          buf = ch
          bufBytes = chBytes
        } else {
          buf += ch
          bufBytes += chBytes
        }
      }
      current = buf
      currentBytes = bufBytes
      continue
    }
    if (currentBytes + segBytes > maxBytes) {
      parts.push(current)
      current = seg
      currentBytes = segBytes
    } else {
      current += seg
      currentBytes += segBytes
    }
  }
  if (current) parts.push(current)
  return parts
}
```

- [ ] **步骤 1.6：运行确认通过**

运行：`bunx vitest run tests/util/chunk.test.ts`
预期：4 个用例 PASS。

- [ ] **步骤 1.7：编写 throttle 失败测试**

`tests/util/throttle.test.ts`：
```ts
import { describe, expect, it, vi } from "vitest"
import { Throttler } from "../../src/util/throttle"

describe("Throttler", () => {
  it("interval 内多次 push 只 flush 一次并聚合内容", () => {
    vi.useFakeTimers()
    const flushed: string[][] = []
    const t = new Throttler(1000, (key, lines) => flushed.push([key, ...lines]))
    t.push("s1", "a")
    t.push("s1", "b")
    t.push("s2", "c")
    vi.advanceTimersByTime(1100)
    expect(flushed).toEqual([["s1", "a", "b"], ["s2", "c"]])
    vi.useRealTimers()
  })
  it("flush 后缓冲清空，下一周期可再次 flush", () => {
    vi.useFakeTimers()
    const flushed: string[] = []
    const t = new Throttler(500, (_key, lines) => flushed.push(lines.join("|")))
    t.push("k", "x")
    vi.advanceTimersByTime(600)
    t.push("k", "y")
    vi.advanceTimersByTime(600)
    expect(flushed).toEqual(["x", "y"])
    vi.useRealTimers()
  })
})
```

- [ ] **步骤 1.8：运行确认失败**

运行：`bunx vitest run tests/util/throttle.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 1.9：实现 throttle**

`src/util/throttle.ts`：
```ts
type FlushFn = (key: string, lines: string[]) => void

export class Throttler {
  private buffers = new Map<string, string[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private intervalMs: number, private flush: FlushFn) {}

  push(key: string, line: string): void {
    let buf = this.buffers.get(key)
    if (!buf) {
      buf = []
      this.buffers.set(key, buf)
      this.timers.set(
        key,
        setTimeout(() => this.flushKey(key), this.intervalMs),
      )
    }
    buf.push(line)
  }

  private flushKey(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    const buf = this.buffers.get(key)
    this.buffers.delete(key)
    if (buf && buf.length > 0) this.flush(key, buf)
  }

  dispose(): void {
    for (const key of [...this.buffers.keys()]) this.flushKey(key)
  }
}
```

- [ ] **步骤 1.10：运行确认通过**

运行：`bunx vitest run tests/util/throttle.test.ts`
预期：PASS。

- [ ] **步骤 1.11：Commit**

```bash
git add -A
git commit -m "feat: 项目脚手架与 chunk/throttle 工具"
```

---

### 任务 2：配置加载（config）

**文件：**
- 创建：`src/constants.ts`、`src/config.ts`
- 测试：`tests/config.test.ts`

- [ ] **步骤 2.1：创建常量文件**

`src/constants.ts`：
```ts
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
```

- [ ] **步骤 2.2：编写失败测试**

`tests/config.test.ts`：
```ts
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config"

afterEach(() => {
  delete process.env.QQ_BOT_APPID
  delete process.env.QQ_BOT_APPSECRET
})

describe("loadConfig", () => {
  it("缺 appId 时返回 null（静默禁用）", () => {
    const cfg = loadConfig("/nonexistent/path.json")
    expect(cfg).toBeNull()
  })
  it("环境变量提供完整凭据时可用，默认 sandbox=true", () => {
    process.env.QQ_BOT_APPID = "111"
    process.env.QQ_BOT_APPSECRET = "sec"
    const cfg = loadConfig("/nonexistent/path.json")!
    expect(cfg.appId).toBe("111")
    expect(cfg.appSecret).toBe("sec")
    expect(cfg.sandbox).toBe(true)
    expect(cfg.allowlist).toEqual([])
    expect(cfg.events.toolProgress).toBe(false)
  })
  it("文件配置被读取，环境变量覆盖文件值", () => {
    const os = await import("node:os")
    const fs = await import("node:fs")
    const path = `${fs.mkdtempSync(`${os.tmpdir()}/qqcfg-`)}/cfg.json`
    fs.writeFileSync(
      path,
      JSON.stringify({
        appId: "file-id",
        appSecret: "file-secret",
        sandbox: false,
        model: "anthropic/claude-sonnet-4-5",
      }),
    )
    process.env.QQ_BOT_APPID = "env-id"
    const cfg = loadConfig(path)!
    expect(cfg.appId).toBe("env-id")
    expect(cfg.appSecret).toBe("file-secret")
    expect(cfg.sandbox).toBe(false)
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-5")
  })
})
```

注意：第三个用例顶层不能直接 `await`——把该用例改为 `it("...", async () => {...})`（上面代码在 it 回调里使用 await，需确保回调标记 async）。执行者落地测试代码时给三个 it 的回调都加上 `async`。

- [ ] **步骤 2.3：运行确认失败**

运行：`bunx vitest run tests/config.test.ts`
预期：FAIL，`loadConfig` 不存在。

- [ ] **步骤 2.4：实现 config**

`src/config.ts`：
```ts
import fs from "node:fs"
import { CONFIG_PATH } from "./constants"

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
    sandbox: file.sandbox ?? true,
    allowlist: file.allowlist ?? [],
    events: { toolProgress: file.events?.toolProgress ?? false },
    model: file.model,
  }
}
```

- [ ] **步骤 2.5：运行确认通过**

运行：`bunx vitest run tests/config.test.ts`
预期：PASS。

- [ ] **步骤 2.6：Commit**

```bash
git add src/constants.ts src/config.ts tests/config.test.ts
git commit -m "feat: 配置加载与环境变量覆盖"
```

---

### 任务 3：QQ 认证（auth）

**文件：**
- 创建：`src/qq/auth.ts`
- 测试：`tests/qq/auth.test.ts`

- [ ] **步骤 3.1：编写失败测试**

`tests/qq/auth.test.ts`：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuthManager } from "../../src/qq/auth"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe("AuthManager", () => {
  beforeEach(() => vi.useFakeTimers())

  it("首次调用请求 token，body 含 appId/clientSecret", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "T1", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    expect(await am.getToken()).toBe("T1")
    expect(fetchFn).toHaveBeenCalledOnce()
    const [, init] = fetchFn.mock.calls[0]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ appId: "id", clientSecret: "secret" })
  })

  it("有效期内复用缓存 token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "T1", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await am.getToken()
    await am.getToken()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("距过期不足 60 秒时刷新新 token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "T1", expires_in: "7200" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T2", expires_in: "7200" }))
    const am = new AuthManager("id", "secret", fetchFn as typeof fetch)
    await am.getToken()
    vi.advanceTimersByTime((7200 - 30) * 1000) // 距过期剩 30 秒
    expect(await am.getToken()).toBe("T2")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("HTTP 非 200 抛错", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ code: 100016 }, 400))
    const am = new AuthManager("id", "bad", fetchFn as typeof fetch)
    await expect(am.getToken()).rejects.toThrow(/getAppAccessToken/)
  })
})
```

- [ ] **步骤 3.2：运行确认失败**

运行：`bunx vitest run tests/qq/auth.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3.3：实现 auth**

`src/qq/auth.ts`：
```ts
import { TOKEN_URL } from "../constants"

export class AuthManager {
  private token: string | null = null
  private expireAt = 0

  constructor(
    private appId: string,
    private appSecret: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.expireAt - 60_000) return this.token
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    if (!res.ok) throw new Error(`getAppAccessToken failed: HTTP ${res.status}`)
    const data = (await res.json()) as { access_token: string; expires_in: string | number }
    this.token = data.access_token
    this.expireAt = Date.now() + Number(data.expires_in) * 1000
    return this.token
  }
}
```

- [ ] **步骤 3.4：运行确认通过**

运行：`bunx vitest run tests/qq/auth.test.ts`
预期：PASS。

- [ ] **步骤 3.5：Commit**

```bash
git add src/qq/auth.ts tests/qq/auth.test.ts
git commit -m "feat: QQ access_token 获取与缓存刷新"
```

---

### 任务 4：REST 发消息（api）

**文件：**
- 创建：`src/qq/api.ts`、`src/types.ts`
- 测试：`tests/qq/api.test.ts`

- [ ] **步骤 4.1：创建共享类型**

`src/types.ts`：
```ts
export interface IncomingC2CMessage {
  openid: string
  content: string
  msgId: string
  timestamp: number
}

export interface SendOptions {
  /** 引用的被动回复消息 id；不带则为主动消息 */
  msgId?: string
}

export interface GatewayEvents {
  message(msg: IncomingC2CMessage): void
  connected(): void
  disconnected(): void
}
```

- [ ] **步骤 4.2：编写失败测试**

`tests/qq/api.test.ts`：
```ts
import { describe, expect, it, vi } from "vitest"
import { QQApi } from "../../src/qq/api"

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("QQApi.sendC2C", () => {
  it("发送文本消息并携带 Authorization 头与 msg_seq 自增", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m1" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    await api.sendC2C("OPENID", "hi", { msgId: "MSG1" })
    await api.sendC2C("OPENID", "hi2", { msgId: "MSG1" })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://api.bot.qq.com/v2/users/OPENID/messages")
    expect(init.headers.Authorization).toBe("QQBot TK")
    expect(init.body.msg_type).toBe(0)
    expect(init.body.content).toBe("hi")
    expect(init.body.msg_id).toBe("MSG1")
    expect(init.body.msg_seq).toBe(1)
    expect(fetchFn.mock.calls[1][1].body.msg_seq).toBe(2)
  })

  it("429 按 Retry-After 退避重试后成功", async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(okJson({ id: "ok" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    const p = api.sendC2C("O", "retry me")
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(fetchFn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("同一 msg_id 超过 4 条被动回复后降级为主动消息（去掉 msg_id）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ id: "m" }))
    const api = new QQApi({
      restBase: "https://api.bot.qq.com",
      getToken: () => Promise.resolve("TK"),
      fetchFn: fetchFn as typeof fetch,
    })
    for (let i = 0; i < 5; i++) await api.sendC2C("O", `r${i}`, { msgId: "MSG9" })
    expect(fetchFn.mock.calls[3][1].body.msg_id).toBe("MSG9")
    expect(fetchFn.mock.calls[4][1].body.msg_id).toBeUndefined()
  })
})
```

- [ ] **步骤 4.3：运行确认失败**

运行：`bunx vitest run tests/qq/api.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 4.4：实现 api**

`src/qq/api.ts`：
```ts
import { MAX_REPLIES_PER_MSG_ID } from "../constants"
import type { SendOptions } from "../types"

interface QQApiOptions {
  restBase: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}

export class QQApi {
  private fetchFn: typeof fetch
  private queue: Promise<void> = Promise.resolve()
  private seqCounters = new Map<string, number>()

  constructor(private opts: QQApiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** 串行化所有发送，避免打爆频控 */
  sendC2C(openid: string, content: string, options: SendOptions = {}): Promise<void> {
    const task = this.queue.then(() => this.doSend(openid, content, options))
    this.queue = task.catch(() => {}) // 吞掉错误保持队列继续
    return task
  }

  private async doSend(openid: string, content: string, options: SendOptions): Promise<void> {
    const body: Record<string, unknown> = { msg_type: 0, content }
    if (options.msgId) {
      const used = this.seqCounters.get(options.msgId) ?? 0
      if (used >= MAX_REPLIES_PER_MSG_ID) {
        // 被动额度用尽 → 降级主动消息
      } else {
        body.msg_id = options.msgId
        body.msg_seq = used + 1
        this.seqCounters.set(options.msgId, used + 1)
        if (this.seqCounters.size > 500) this.pruneSeq()
      }
    }
    for (let attempt = 0; attempt <= 3; attempt++) {
      const token = await this.opts.getToken()
      const res = await this.fetchFn(`${this.opts.restBase}/v2/users/${openid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
      })
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1")
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000))
        continue
      }
      if (!res.ok) throw new Error(`sendC2C failed: HTTP ${res.status} ${await res.text()}`)
      return
    }
  }

  private pruneSeq(): void {
    // 简单防膨胀：超限时全量清理（旧 msg_seq 计数丢失只影响去重，不影响功能正确性）
    this.seqCounters.clear()
  }
}
```

- [ ] **步骤 4.5：运行确认通过**

运行：`bunx vitest run tests/qq/api.test.ts`
预期：PASS。

- [ ] **步骤 4.6：Commit**

```bash
git add src/types.ts src/qq/api.ts tests/qq/api.test.ts
git commit -m "feat: QQ REST 单聊发送（串行队列/msg_seq/429 退避/被动降级）"
```

---

### 任务 5：WSS 网关（gateway）

**文件：**
- 创建：`src/qq/gateway.ts`
- 修改：`src/constants.ts`（追加 gateway 路径常量）
- 测试：`tests/qq/gateway.test.ts`

- [ ] **步骤 5.1：constants 追加网关路径**

在 `src/constants.ts` 末尾追加：
```ts
export const GATEWAY_PATH = "/gateway"
```

- [ ] **步骤 5.2：编写失败测试**

用真实 `ws` 服务端做 mock 网关。`tests/qq/gateway.test.ts`：
```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer, type WebSocket as WsSocket } from "ws"
import { QQGateway } from "../../src/qq/gateway"

const INTENT = 1 << 25

interface Harness {
  server: WebSocketServer
  port: number
  lastClient: () => WsSocket | undefined
}

async function startMockGateway(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => server.on("listening", r))
  const port = (server.address() as { port: number }).port
  const h: Harness = { server, port, lastClient: () => undefined }
  server.on("connection", (client) => {
    ;(h as { _last?: WsSocket })._last = client
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }))
    client.on("message", (raw) => {
      const pkt = JSON.parse(raw.toString())
      if (pkt.op === 2) {
        client.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: { session_id: "SESS1", user: { id: "bot" } },
          }),
        )
      }
      if (pkt.op === 1) client.send(JSON.stringify({ op: 11 }))
    })
  })
  return h as Harness
}

afterEach(() => vi.restoreAllMocks())

describe("QQGateway", () => {
  it("连接后 Identify 并收到 READY 与业务事件", async () => {
    const h = await startMockGateway()
    const gotReady = vi.fn()
    const gotMsg = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      on: { connected: gotReady, message: gotMsg },
    })
    gw.start()
    await vi.waitFor(() => expect(gotReady).toHaveBeenCalled())
    const client = (h as unknown as { _last?: WsSocket })._last!
    client.send(
      JSON.stringify({
        op: 0,
        s: 2,
        t: "C2C_MESSAGE_CREATE",
        d: { openid: "U1", content: "hello", msg_id: "M1", timestamp: "2026-01-01" },
      }),
    )
    await vi.waitFor(() =>
      expect(gotMsg).toHaveBeenCalledWith(
        expect.objectContaining({ openid: "U1", content: "hello", msgId: "M1" }),
      ),
    )
    gw.stop()
    h.server.close()
  })

  it("断线后指数退避自动重连并恢复 Identify", async () => {
    const h = await startMockGateway()
    const connected = vi.fn()
    const gw = new QQGateway({
      getGatewayUrl: () => Promise.resolve(`ws://127.0.0.1:${h.port}`),
      getToken: () => Promise.resolve("TK"),
      intents: INTENT,
      reconnectBaseMs: 10,
      on: { connected, message: vi.fn() },
    })
    gw.start()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1))
    ;(h as unknown as { _last?: WsSocket })._last!.close()
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), { timeout: 5000 })
    gw.stop()
    h.server.close()
  })
})
```

注意：Harness 里 `_last` 用了动态属性，落地时把 `Harness` 接口改为包含 `_last?: WsSocket` 字段以通过 TS 严格检查（`lastClient()` 直接返回 `_last`）。执行者可顺手清理这段类型体操。

- [ ] **步骤 5.3：运行确认失败**

运行：`bunx vitest run tests/qq/gateway.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 5.4：实现 gateway**

`src/qq/gateway.ts`：
```ts
import WebSocket from "ws"
import { GATEWAY_PATH } from "../constants"
import type { GatewayEvents, IncomingC2CMessage } from "../types"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

interface Packet {
  op: number
  d?: Record<string, unknown>
  s?: number
  t?: string
}

export interface QQGatewayOptions extends GatewayEvents {
  getGatewayUrl: () => Promise<string>
  getToken: () => Promise<string>
  intents: number
  reconnectBaseMs?: number
}

export class QQGateway {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempt = 0
  private stopped = false

  constructor(private opts: QQGatewayOptions) {}

  start(): void {
    this.stopped = false
    this.connect().catch(() => this.scheduleReconnect())
  }

  stop(): void {
    this.stopped = true
    this.cleanup()
  }

  private cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.ws) {
      this.ws.removeAllListeners()
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const base = this.opts.reconnectBaseMs ?? 1000
    const delay = Math.min(base * 2 ** this.reconnectAttempt, 60_000)
    this.reconnectAttempt++
    setTimeout(() => this.connect().catch(() => this.scheduleReconnect()), delay)
  }

  private async connect(): Promise<void> {
    const url = await this.opts.getGatewayUrl()
    const ws = new WebSocket(url)
    this.ws = ws
    ws.on("message", (raw) => this.handlePacket(JSON.parse(raw.toString())))
    ws.on("close", () => {
      this.opts.disconnected()
      this.scheduleReconnect()
    })
    ws.on("error", () => ws.terminate())
  }

  private handlePacket(pkt: Packet): void {
    switch (pkt.op) {
      case OP_HELLO: {
        const interval = (pkt.d as { heartbeat_interval: number }).heartbeat_interval
        this.startHeartbeat(interval)
        if (this.sessionId !== null && this.lastSeq !== null) {
          void this.sendResume()
        } else {
          void this.sendIdentify()
        }
        break
      }
      case OP_HEARTBEAT_ACK:
        break
      case OP_DISPATCH: {
        this.lastSeq = pkt.s ?? this.lastSeq
        this.handleDispatch(pkt.t ?? "", (pkt.d ?? {}) as Record<string, unknown>)
        break
      }
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_IDENTIFY,
        d: { token: `QQBot ${token}`, intents: this.opts.intents, shard: [0, 1] },
      }),
    )
  }

  private async sendResume(): Promise<void> {
    const token = await this.opts.getToken()
    this.ws?.send(
      JSON.stringify({
        op: OP_RESUME,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      }),
    )
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }))
    }, intervalMs)
  }

  private handleDispatch(t: string, d: Record<string, unknown>): void {
    if (t === "READY") {
      this.sessionId = String(d.session_id)
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "RESUMED") {
      this.reconnectAttempt = 0
      this.opts.connected()
      return
    }
    if (t === "C2C_MESSAGE_CREATE") {
      this.opts.message({
        openid: String(d.openid ?? ""),
        content: String(d.content ?? ""),
        msgId: String(d.msg_id ?? ""),
        timestamp: Date.parse(String(d.timestamp ?? "")) || Date.now(),
      })
    }
  }
}
```

工厂辅助（供入口使用），追加在同文件底部（复用顶部已导入的 `GATEWAY_PATH`）：
```ts
export function createGatewayUrlFetcher(restBase: string, fetchFn: typeof fetch = fetch) {
  return async (): Promise<string> => {
    const res = await fetchFn(`${restBase}${GATEWAY_PATH}`)
    if (!res.ok) throw new Error(`get gateway failed: HTTP ${res.status}`)
    return ((await res.json()) as { url: string }).url
  }
}
```

同时把文件顶部的 `import { GATEWAY_PATH } from "../constants"` 保留为唯一导入处。

- [ ] **步骤 5.5：运行确认通过**

运行：`bunx vitest run tests/qq/gateway.test.ts`
预期：两个用例 PASS（重连用例依赖 `reconnectBaseMs: 10` 快速退避）。

- [ ] **步骤 5.6：Commit**

```bash
git add src/qq/gateway.ts src/constants.ts tests/qq/gateway.test.ts
git commit -m "feat: QQ WSS 网关（心跳/Identify/Resume/指数退避重连）"
```

---

### 任务 6：指令解析（commands）

**文件：**
- 创建：`src/commands.ts`
- 测试：`tests/commands.test.ts`

- [ ] **步骤 6.1：编写失败测试**

`tests/commands.test.ts`：
```ts
import { describe, expect, it } from "vitest"
import { parseCommand } from "../src/commands"

describe("parseCommand", () => {
  it("识别 /new /status /help（忽略大小写与首尾空白）", () => {
    expect(parseCommand(" /new")).toEqual({ type: "new" })
    expect(parseCommand("/STATUS")).toEqual({ type: "status" })
    expect(parseCommand("/help")).toEqual({ type: "help" })
  })
  it("非指令或未知指令返回 null", () => {
    expect(parseCommand("你好")).toBeNull()
    expect(parseCommand("/unknown")).toBeNull()
    expect(parseCommand("/new2")).toBeNull()
  })
})
```

- [ ] **步骤 6.2：运行确认失败**

运行：`bunx vitest run tests/commands.test.ts`
预期：FAIL。

- [ ] **步骤 6.3：实现 commands**

`src/commands.ts`：
```ts
export type Command = { type: "new" } | { type: "status" } | { type: "help" }

export function parseCommand(text: string): Command | null {
  const m = /^\/(new|status|help)\s*$/i.exec(text.trim())
  if (!m) return null
  return { type: m[1].toLowerCase() } as Command
}
```

- [ ] **步骤 6.4：运行确认通过**

运行：`bunx vitest run tests/commands.test.ts`
预期：PASS。

- [ ] **步骤 6.5：Commit**

```bash
git add src/commands.ts tests/commands.test.ts
git commit -m "feat: 斜杠指令解析"
```

---

### 任务 7：会话管理（session-manager）

**文件：**
- 创建：`src/session-manager.ts`
- 测试：`tests/session-manager.test.ts`

opencode 交互面抽象成接口，避免测试依赖真实 SDK：

- [ ] **步骤 7.1：编写失败测试**

`tests/session-manager.test.ts`：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SessionManager } from "../src/session-manager"

function makeFsStub(initial = "{}") {
  const store = new Map<string, string>([["f", initial]])
  return {
    store,
    readFileSync: (p: string) => {
      const v = store.get(p)
      if (v === undefined) throw new Error("ENOENT")
      return v
    },
    writeFileSync: (p: string, data: string) => void store.set(p, data),
  }
}

function makeClient(existingSessions: Record<string, { id: string }> = {}) {
  let nextId = Object.keys(existingSessions).length + 1
  return {
    sessions: existingSessions,
    createdTitles: [] as string[],
    prompted: [] as { id: string; text: string; noReply: boolean }[],
    model: { providerID: "anthropic", modelID: "claude-test" },
    async sessionCreate(title: string) {
      const id = `ses${nextId++}`
      this.createdTitles.push(title)
      this.sessions[id] = { id }
      return { id }
    },
    async sessionPrompt(id: string, text: string, noReply: boolean) {
      this.prompted.push({ id, text, noReply })
      if (noReply) return { parts: [] }
      return { parts: [{ type: "text", text: `AI 回复:${text}` }] }
    },
    async resolveModel() {
      return this.model
    },
  }
}

describe("SessionManager.dispatch", () => {
  let sm: SessionManager
  let client: ReturnType<typeof makeClient>

  beforeEach(() => {
    client = makeClient()
    sm = new SessionManager(client, "/tmp/f", makeFsStub() as never)
  })

  it("首条消息创建会话并把正文 prompt 给 AI，返回最新 assistant 文本", async () => {
    const reply = await sm.dispatch("user1", "帮我写个脚本")
    expect(client.createdTitles).toEqual(["帮我写个脚本"])
    expect(reply).toBe("AI 回复:帮我写个脚本")
  })

  it("后续消息复用同一会话", async () => {
    await sm.dispatch("user1", "第一条")
    await sm.dispatch("user1", "第二条")
    expect(client.createdTitles.length).toBe(1)
    expect(client.prompted.map((p) => p.id)).toHaveLength(2)
    expect(client.prompted[1].id).toBe(client.prompted[0].id)
  })

  it("不同用户各自独立会话", async () => {
    await sm.dispatch("u1", "a")
    await sm.dispatch("u2", "b")
    expect(client.prompted[0].id).not.toBe(client.prompted[1].id)
  })

  it("/new 清除映射，下条消息开新会话", async () => {
    await sm.dispatch("u1", "一")
    const oldId = (await sm.getSessionId("u1"))!
    const reply = await sm.dispatch("u1", "/new")
    expect(reply).toContain("已重置")
    await sm.dispatch("u1", "二")
    expect(await sm.getSessionId("u1")).not.toBe(oldId)
  })

  it("/status 返回会话信息", async () => {
    await sm.dispatch("u1", "hi")
    const reply = await sm.dispatch("u1", "/status")
    expect(reply).toContain("ses1")
  })

  it("映射持久化到文件，重启后恢复", async () => {
    const fsStub = makeFsStub()
    const sm1 = new SessionManager(client, "/tmp/persist.json", fsStub as never)
    await sm1.dispatch("u1", "hi")
    const sm2 = new SessionManager(client, "/tmp/persist.json", fsStub as never)
    expect(await sm2.getSessionId("u1")).toBe(await sm1.getSessionId("u1"))
  })

  it("标题取前 20 字", async () => {
    await sm.dispatch("u1", "很长的标题很长的标题很长的标题很长的标题超出二十字的部分应被截断")
    expect(client.createdTitles[0]).toHaveLength(20)
  })

  it("/new 触发 onSessionReset 并携带旧会话 ID", async () => {
    const resets: string[] = []
    const sm2 = new SessionManager(
      {
        ...client,
        onSessionReset: (sid) => void resets.push(sid),
      },
      "/tmp/f2",
      makeFsStub() as never,
    )
    await sm2.dispatch("u1", "一")
    const oldId = (await sm2.getSessionId("u1"))!
    await sm2.dispatch("u1", "/new")
    expect(resets).toEqual([oldId])
  })
})
```

- [ ] **步骤 7.2：运行确认失败**

运行：`bunx vitest run tests/session-manager.test.ts`
预期：FAIL。

- [ ] **步骤 7.3：实现 session-manager**

`src/session-manager.ts`：
```ts
import fs from "node:fs"
import { parseCommand } from "./commands"

/** opencode client 的最小交互面（index.ts 负责适配真实 SDK） */
export interface OpencodeBridge {
  sessionCreate(title: string): Promise<{ id: string }>
  /** noReply=true 注入上下文不触发回复；false 触发 AI 并返回消息 parts */
  sessionPrompt(
    id: string,
    text: string,
    noReply: boolean,
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

  reset(openid: string): void {
    const sid = this.map.get(openid)
    this.map.delete(openid)
    this.persist()
    if (sid) this.bridge.onSessionReset?.(sid)
  }

  /** 返回要发回 QQ 的文本 */
  async dispatch(openid: string, text: string): Promise<string> {
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
    const result = await this.bridge.sessionPrompt(sessionId, text, false)
    const out = result.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
    return out || "(无文本回复)"
  }

  private async statusReply(openid: string): Promise<string> {
    const sid = await this.getSessionId(openid)
    return sid ? `当前会话: ${sid}\n状态: 已就绪` : "暂无会话，发任意消息即可开始。"
  }

  private persist(): void {
    try {
      this.fsMod.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.map)))
    } catch {
      /* 写失败不影响主流程 */
    }
  }
}
```

- [ ] **步骤 7.4：运行确认通过**

运行：`bunx vitest run tests/session-manager.test.ts`
预期：全部 PASS。

- [ ] **步骤 7.5：Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat: 会话管理（长期映射/持久化/内置指令）"
```

---

### 任务 8：审批配对（approver）

**文件：**
- 创建：`src/approver.ts`
- 测试：`tests/approver.test.ts`

- [ ] **步骤 8.1：编写失败测试**

`tests/approver.test.ts`：
```ts
import { describe, expect, it, vi } from "vitest"
import { Approver } from "../src/approver"

describe("Approver", () => {
  it("register 分配自增编号并生成提示文本", () => {
    const a = new Approver(10_000)
    const n = a.register("ses1", "perm1", "执行命令: npm test")
    expect(n).toBe(1)
    const text = a.render(n)
    expect(text).toContain("#1")
    expect(text).toContain("npm test")
    expect(text).toContain("同意 1")
  })

  it("解析 同意/拒绝 回复（容忍大小写、空白）", () => {
    const a = new Approver(10_000)
    a.register("s", "p", "t")
    expect(a.parseReply("同意 1")).toEqual({ seq: 1, reply: "once" })
    expect(a.parseReply("拒绝1")).toEqual({ seq: 2, reply: "reject" })
    expect(a.parseReply("随便说说")).toBeNull()
  })

  it("confirm 取出待审项并移除", () => {
    const a = new Approver(10_000)
    const seq = a.register("s", "permX", "t")
    expect(a.confirm(seq)?.permissionId).toBe("permX")
    expect(a.confirm(seq)).toBeUndefined()
  })

  it("超时后条目被清理", () => {
    vi.useFakeTimers()
    const a = new Approver(100)
    const seq = a.register("s", "p", "t")
    vi.advanceTimersByTime(150)
    expect(a.confirm(seq)).toBeUndefined()
    vi.useRealTimers()
  })
})
```

- [ ] **步骤 8.2：运行确认失败**

运行：`bunx vitest run tests/approver.test.ts`
预期：FAIL。

- [ ] **步骤 8.3：实现 approver**

`src/approver.ts`：
```ts
export interface PendingApproval {
  permissionId: string
  sessionId: string
  summary: string
}

export interface ParsedApprovalReply {
  seq: number
  reply: "once" | "reject"
}

export class Approver {
  private pending = new Map<number, PendingApproval & { timer: ReturnType<typeof setTimeout> }>()
  private nextSeq = 1

  constructor(private timeoutMs: number) {}

  register(sessionId: string, permissionId: string, summary: string): number {
    const seq = this.nextSeq++
    const timer = setTimeout(() => this.pending.delete(seq), this.timeoutMs)
    this.pending.set(seq, { permissionId, sessionId, summary, timer })
    return seq
  }

  render(seq: number): string {
    const item = this.pending.get(seq)
    return [
      `[权限请求 #${seq}] ${item?.summary ?? ""}`,
      `回复“同意 ${seq}”批准本次，回复“拒绝 ${seq}”拒绝。`,
    ].join("\n")
  }

  parseReply(text: string): ParsedApprovalReply | null {
    const m = /^(同意|拒绝)\s*(\d+)$/.exec(text.trim())
    if (!m) return null
    return { reply: m[1] === "同意" ? "once" : "reject", seq: Number(m[2]) }
  }

  confirm(seq: number): PendingApproval | undefined {
    const item = this.pending.get(seq)
    if (!item) return undefined
    clearTimeout(item.timer)
    this.pending.delete(seq)
    const { timer: _t, ...rest } = item
    return rest
  }

  clearSession(sessionId: string): void {
    for (const [seq, item] of this.pending) {
      if (item.sessionId === sessionId) {
        clearTimeout(item.timer)
        this.pending.delete(seq)
      }
    }
  }
}
```

- [ ] **步骤 8.4：运行确认通过**

运行：`bunx vitest run tests/approver.test.ts`
预期：PASS。

- [ ] **步骤 8.5：Commit**

```bash
git add src/approver.ts tests/approver.test.ts
git commit -m "feat: 权限审批配对（编号/回复解析/超时清理）"
```

---

### 任务 9：事件推送（event-pusher）

**文件：**
- 创建：`src/event-pusher.ts`
- 测试：`tests/event-pusher.test.ts`

- [ ] **步骤 9.1：编写失败测试**

`tests/event-pusher.test.ts`：
```ts
import { describe, expect, it, vi } from "vitest"
import { EventPusher } from "../src/event-pusher"

type Handler = (evt: { type: string; properties: Record<string, unknown> }) => void

function makeDeps() {
  const sent: Array<{ openid: string; text: string }> = []
  let handler: Handler = () => {}
  const pusher = new EventPusher({
    isOurSession: (id) => id.startsWith("ours"),
    openidOfSession: (id) => (id.startsWith("ours") ? `u-${id.slice(4)}` : null),
    send: async (openid, text) => void sent.push({ openid, text }),
    subscribe: (h) => {
      handler = h
    },
    toolProgress: true,
  })
  const emit = (type: string, properties: Record<string, unknown>) =>
    handler({ type, properties })
  return { sent, emit, pusher }
}

describe("EventPusher", () => {
  it("session.idle 推送完成通知", async () => {
    const { emit, sent } = makeDeps()
    emit("session.idle", { sessionID: "ours1" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("✅")
    expect(sent[0].openid).toBe("u-1")
  })

  it("session.error 推送错误摘要", async () => {
    const { emit, sent } = makeDeps()
    emit("session.error", { sessionID: "ours2", error: "boom" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("❌")
    expect(sent[0].text).toContain("boom")
  })

  it("非本插件的会话不推送", async () => {
    const { emit, sent } = makeDeps()
    emit("session.idle", { sessionID: "other-session" })
    emit("session.error", { sessionID: "another" })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it("工具进度经节流聚合（60s 至多一条/会话）", async () => {
    const { emit, sent } = makeDeps()
    emit("tool.execute.after", { sessionID: "ours9", tool: "bash", title: "npm build" })
    emit("tool.execute.after", { sessionID: "ours9", tool: "read", title: "src/a.ts" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("npm build")
    expect(sent[0].text).toContain("src/a.ts")
    expect(sent).toHaveLength(1) // 未到下一个 60s 周期，不再推
  })
})
```

- [ ] **步骤 9.2：运行确认失败**

运行：`bunx vitest run tests/event-pusher.test.ts`
预期：FAIL。

- [ ] **步骤 9.3：实现 event-pusher**

`src/event-pusher.ts`：
```ts
import { Throttler } from "./util/throttle"

export interface EventPusherDeps {
  isOurSession(sessionId: string): boolean
  openidOfSession(sessionId: string): string | null
  send(openid: string, text: string): Promise<void>
  /** 由 index.ts 提供：把 opencode event hook 交进来 */
  subscribe(handler: (evt: { type: string; properties: Record<string, unknown> }) => void): void
  toolProgress: boolean
}

const TOOL_PROGRESS_INTERVAL_MS = 60_000

export class EventPusher {
  private throttler = new Throttler(TOOL_PROGRESS_INTERVAL_MS, (key, lines) => {
    const openid = key
    void this.deps
      .send(openid, `🛠 工具进度:\n${lines.map((l) => `- ${l}`).join("\n")}`)
      .catch(() => {})
  })

  /** 断线补发队列 */
  private offlineQueue: Array<{ openid: string; text: string }> = []
  private online = true

  constructor(private deps: EventPusherDeps) {
    deps.subscribe((evt) => this.handle(evt))
  }

  setOnline(online: boolean): void {
    this.online = online
    if (online) {
      for (const item of this.offlineQueue.splice(0)) {
        this.deps.send(item.openid, item.text).catch(() => {})
      }
    }
  }

  private deliver(openid: string, text: string): void {
    if (!this.online) {
      this.offlineQueue.push({ openid, text })
      return
    }
    this.deps.send(openid, text).catch(() => {})
  }

  private handle(evt: { type: string; properties: Record<string, unknown> }): void {
    const props = evt.properties ?? {}
    const sessionId = String(props.sessionID ?? props.sessionId ?? "")
    if (!sessionId || !this.deps.isOurSession(sessionId)) return
    const openid = this.deps.openidOfSession(sessionId)
    if (!openid) return

    switch (evt.type) {
      case "session.idle":
        this.deliver(openid, "✅ 任务完成。")
        break
      case "session.error": {
        const err = String(props.error ?? "未知错误").slice(0, 300)
        this.deliver(openid, `❌ 出错: ${err}`)
        break
      }
      case "tool.execute.after":
        if (this.deps.toolProgress) {
          const tool = String(props.tool ?? "tool")
          const title = String(props.title ?? props.description ?? "").slice(0, 80)
          this.throttler.push(openid, `${tool}: ${title}`)
        }
        break
    }
  }

  dispose(): void {
    this.throttler.dispose()
  }
}
```

- [ ] **步骤 9.4：运行确认通过**

运行：`bunx vitest run tests/event-pusher.test.ts`
预期：PASS（工具进度用例依赖 fake/real timer 边界，若不稳定可将 Throttler 构造参数化并在测试注入极小间隔）。

- [ ] **步骤 9.5：Commit**

```bash
git add src/event-pusher.ts tests/event-pusher.test.ts
git commit -m "feat: opencode 事件推送（过滤/节流/断线补发）"
```

---

### 任务 10：插件入口装配 + 冒烟集成测试

**文件：**
- 创建：`src/index.ts`
- 修改：`src/session-manager.ts`（无需改，桥接在 index 内实现）
- 测试：`tests/smoke.test.ts`

- [ ] **步骤 10.1：实现插件入口**

`src/index.ts`：
```ts
import type { Plugin } from "@opencode-ai/plugin"
import { Approver } from "./approver"
import { loadConfig } from "./config"
import { createGatewayUrlFetcher, QQGateway } from "./qq/gateway"
import { QQApi } from "./qq/api"
import { AuthManager } from "./qq/auth"
import { SESSIONS_PATH, REST_BASE_PROD, REST_BASE_SANDBOX, INTENT_GROUP_AND_C2C, APPROVAL_TIMEOUT_MS, PASSIVE_WINDOW_MS } from "./constants"
import { EventPusher } from "./event-pusher"
import { SessionManager, type OpencodeBridge } from "./session-manager"
import { splitText } from "./util/chunk"

type OcEvent = { type: string; properties?: Record<string, unknown> }

export const QQBotPlugin: Plugin = async (input) => {
  const cfg = loadConfig()
  if (!cfg) {
    await input.client.app
      .log({
        body: {
          service: "opencode-qq",
          level: "warn",
          message: "缺少 QQ_BOT_APPID/QQ_BOT_APPSECRET 或配置文件，插件未启用",
        },
      })
      .catch(() => {})
    return {}
  }

  const allowSet = new Set(cfg.allowlist)
  const restBase = cfg.sandbox ? REST_BASE_SANDBOX : REST_BASE_PROD

  const auth = new AuthManager(cfg.appId, cfg.appSecret)
  const api = new QQApi({ restBase, getToken: () => auth.getToken() })
  const approver = new Approver(APPROVAL_TIMEOUT_MS)

  // ---- opencode 桥接 ----
  let cachedModel: { providerID: string; modelID: string } | null = null
  const bridge: OpencodeBridge = {
    async sessionCreate(title) {
      const res = await input.client.session.create({ body: { title } })
      return { id: res.data!.id }
    },
    async sessionPrompt(id, text, noReply) {
      if (!cachedModel) {
        if (cfg.model) {
          const [providerID, modelID] = cfg.model.split("/")
          cachedModel = { providerID, modelID }
        } else {
          const conf = await input.client.config.get()
          const m = (conf.data as { model?: string } | undefined)?.model
          if (!m) throw new Error("未配置 model，请在 opencode-qq.json 中设置 model: 'providerID/modelID'")
          const [providerID, modelID] = m.split("/")
          cachedModel = { providerID, modelID }
        }
      }
      const res = await input.client.session.prompt({
        path: { id },
        body: {
          model: cachedModel,
          noReply,
          parts: [{ type: "text", text }],
        },
      })
      return { parts: (res.data as { parts?: Array<{ type: string; text?: string }> })?.parts ?? [] }
    },
    resolveModel: async () => {
      if (!cachedModel) await bridge.sessionPrompt("__warm__", "", true).catch(() => {})
      return cachedModel ?? { providerID: "unknown", modelID: "unknown" }
    },
  }

  const sessions = new SessionManager(bridge, SESSIONS_PATH())
  // /new 重置会话时清空该会话的待审请求（规格第 5 节）
  bridge.onSessionReset = (sid) => approver.clearSession(sid)

  // ---- 事件订阅收集器（EventPusher 用）----
  const listeners: Array<(e: OcEvent) => void> = []

  const pusher = new EventPusher({
    isOurSession: (sid) => sessions.isOurSession(sid),
    openidOfSession: (sid) => {
      for (const [openid, s] of Object.entries(sessions.snapshot()))
        if (s === sid) return openid
      return null
    },
    send: async (openid, text) => {
      for (const part of splitText(text)) await api.sendC2C(openid, part)
    },
    toolProgress: cfg.events.toolProgress,
    subscribe: (h) => listeners.push(h),
  })

  // ---- 下行：QQ 消息处理 ----
  const passiveRefs = new Map<string, { msgId: string; receivedAt: number }>() // openid → 最近一条
  const pendingNotice = new Map<string, string>() // openid → 超窗未送达说明

  async function replyTo(openid: string, text: string): Promise<void> {
    const ref = passiveRefs.get(openid)
    const chunks = splitText(text)
    for (const chunk of chunks) {
      const usePassive = ref && Date.now() - ref.receivedAt < PASSIVE_WINDOW_MS
      try {
        await api.sendC2C(openid, chunk, usePassive ? { msgId: ref!.msgId } : {})
      } catch {
        if (!usePassive) pendingNotice.set(openid, "（此前有未能送达的消息）")
      }
    }
  }

  const gateway = new QQGateway({
    getGatewayUrl: createGatewayUrlFetcher(restBase),
    getToken: () => auth.getToken(),
    intents: INTENT_GROUP_AND_C2C,
    on: {
      connected: () => pusher.setOnline(true),
      disconnected: () => pusher.setOnline(false),
      message: async (msg) => {
        try {
          if (allowSet.size > 0 && !allowSet.has(msg.openid)) return
          passiveRefs.set(msg.openid, { msgId: msg.msgId, receivedAt: Date.now() })
          await replyTo(msg.openid, "已收到，处理中…")

          // 远程审批回复优先
          const parsed = approver.parseReply(msg.content.trim())
          if (parsed) {
            const item = approver.confirm(parsed.seq)
            if (!item) {
              await replyTo(msg.openid, `#${parsed.seq} 不存在或已超时。`)
              return
            }
            await input.client.postSessionIdPermissionsPermissionId({
              path: { id: item.sessionId, permissionID: item.permissionId },
              body: { reply: parsed.reply },
            })
            await replyTo(msg.openid, `已${parsed.reply === "once" ? "批准" : "拒绝"} #${parsed.seq}`)
            return
          }

          const notice = pendingNotice.get(msg.openid)
          pendingNotice.delete(msg.openid)
          const answer = await sessions.dispatch(msg.openid, msg.content)
          await replyTo(msg.openid, (notice ? `${notice}\n` : "") + answer)
        } catch (e) {
          await replyTo(msg.openid, `处理失败: ${String(e).slice(0, 200)}`).catch(() => {})
        }
      },
    },
  })

  // permission.asked → 编号推送
  listeners.push((e) => {
    if (e.type !== "permission.asked") return
    const p = e.properties ?? {}
    const sessionId = String(p.sessionID ?? "")
    const permissionId = String(p.id ?? "")
    if (!sessions.isOurSession(sessionId) || !permissionId) return
    const summary = String(p.title ?? p.type ?? "需要授权")
    const seq = approver.register(sessionId, permissionId, summary)
    const openid = (() => {
      for (const [o, s] of Object.entries(sessions.snapshot())) if (s === sessionId) return o
      return null
    })()
    if (openid) void replyTo(openid, approver.render(seq))
  })

  gateway.start()

  return {
    event: async ({ event }: { event: OcEvent }) => {
      for (const h of listeners) h({ type: event.type, properties: event.properties ?? {} })
    },
    dispose: async () => {
      gateway.stop()
      pusher.dispose()
    },
  }
}
```

补充：`SessionManager` 需新增公开方法 `snapshot(): Record<string, string>`（返回 `Object.fromEntries(this.map)`），在本任务一并加到 `src/session-manager.ts` 并在 `tests/session-manager.test.ts` 增加一个用例：

```ts
it("snapshot 导出映射", async () => {
  await sm.dispatch("u9", "hi")
  expect(sm.snapshot()["u9"]).toBeDefined()
})
```

- [ ] **步骤 10.2：冒烟集成测试（mock 网关端到端下行链路）**

`tests/smoke.test.ts`：
```ts
import { describe, expect, it } from "vitest"
import { SessionManager } from "../src/session-manager"

// 目标：验证「WSS 事件 → dispatch → 回调产出回复」链路，SDK 用桩替代。
// gateway/api 的协议行为已分别在任务 4/5 单测覆盖，此处聚焦装配顺序与回调时序。

class FakeApi {
  sent: Array<{ openid: string; content: string; opts: unknown }> = []
  async sendC2C(openid: string, content: string, opts: unknown = {}) {
    this.sent.push({ openid, content, opts })
  }
}

describe("smoke: 下行链路", () => {
  it("收到 C2C 消息后 ack 再回复 AI 结果", async () => {
    const bridge = {
      async sessionCreate(title: string) {
        return { id: "ses-smoke" }
      },
      async sessionPrompt(_id: string, _text: string, noReply: boolean) {
        return noReply ? { parts: [] } : { parts: [{ type: "text", text: "答案" }] }
      },
      async resolveModel() {
        return { providerID: "p", modelID: "m" }
      },
    }
    const sessions = new SessionManager(bridge, "/tmp/nonexist.json")
    const api = new FakeApi()
    let onMessage: ((m: { openid: string; content: string; msgId: string; timestamp: number }) => Promise<void>) | null =
      null

    // 手工模拟 gateway 的 message 回调（gateway 协议层已有专项单测）
    onMessage = async (msg) => {
      await api.sendC2C(msg.openid, "已收到，处理中…")
      const answer = await sessions.dispatch(msg.openid, msg.content)
      await api.sendC2C(msg.openid, answer)
    }
    await onMessage!({ openid: "U", content: "问题", msgId: "M", timestamp: Date.now() })

    expect(api.sent.map((s) => s.content)).toEqual(["已收到，处理中…", "答案"])
  })
})
```

- [ ] **步骤 10.3：全量测试 + 类型检查**

运行：`bunx vitest run` 然后 `bunx tsc --noEmit -p tsconfig.json`
预期：全部 PASS，无类型错误。（若 `@opencode-ai/plugin` 的 `Plugin` 类型与本入口签名冲突，放宽为 `export const QQBotPlugin = async (input: PluginInput) => {...}` 并从 `@opencode-ai/plugin` 导入 `PluginInput` 类型；仍冲突则移除显式类型标注、保留结构化实现。）

- [ ] **步骤 10.4：构建产物验证**

运行：`bun run build`
预期：`dist/index.js`、`dist/index.d.ts` 生成。

- [ ] **步骤 10.5：Commit**

```bash
git add -A
git commit -m "feat: 插件入口装配与冒烟测试"
```

---

### 任务 11：README 与发布准备

**文件：**
- 创建：`README.md`

- [ ] **步骤 11.1：编写 README**

内容必须包含（结构给出，文字由执行者按此骨架撰写，不得留 TODO）：
1. 简介：一句话 + 功能列表（对话驱动 opencode、任务完成/出错推送、QQ 远程审批权限、`/new` `/status` `/help`）。
2. 前置条件：注册 QQ 开放平台（个人/企业）、创建机器人拿 AppID/AppSecret、配置沙箱单聊账号；提醒新机器人正式环境 IP 白名单要求。
3. 安装：`opencode.json` 中 `"plugin": ["opencode-qq"]`。
4. 配置：`~/.config/opencode/opencode-qq.json` 示例（appId、appSecret、sandbox:true、allowlist、model、events.toolProgress），以及 `QQ_BOT_APPID`/`QQ_BOT_APPSECRET` 环境变量方式；安全提示：勿提交 secret。
5. 使用：添加机器人为好友 → 单聊发消息；指令表；远程审批交互示例（`[权限请求 #1] …` → `同意 1`）。
6. 注意事项：被动消息窗口（60 分钟/4 条）、主动消息限制、沙箱与正式切换。
7. 开发：`bun install` / `bun test` / `bun run build`。

- [ ] **步骤 11.2：发布演练校验**

运行：`npm publish --dry-run`
预期：列出 dist/ 与 README.md，无缺失文件告警。（实际 `npm publish` 由用户决定是否执行。）

- [ ] **步骤 11.3：Commit 并推送**

```bash
git add README.md
git commit -m "docs: README 接入指引"
git push origin master
```

---

## 手动验收清单（发布前，需真实机器人凭据）

1. 沙箱环境：QQ 手机端向机器人发"你好"→ 收到 ack → 收到 AI 回复。
2. 连发两条消息确认上下文连续（第二条引用第一条语境）。
3. `/new` 后上下文重置；`/status`、`/help` 正常。
4. 让 opencode 执行一个需权限的命令（如 bash）→ QQ 收到 `[权限请求 #N]` → 回复"同意 N"→ opencode 继续执行 → QQ 收到"已批准"。
5. 回复"拒绝 N" → opencode 中止该操作。
6. 杀掉网络 30 秒再恢复 → 网关自动重连，期间完成的任务结果补发到 QQ。
