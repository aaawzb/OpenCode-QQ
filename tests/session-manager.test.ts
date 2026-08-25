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
    prompted: [] as {
      id: string
      text: string
      noReply: boolean
      files?: Array<{ mime: string; dataUrl: string }>
      model?: { providerID: string; modelID: string }
      directory?: string
    }[],
    interrupted: [] as string[],
    sessionCreateDirs: [] as (string | undefined)[],
    model: { providerID: "anthropic", modelID: "claude-test" },
    async sessionCreate(title: string, directory?: string) {
      const id = `ses${nextId++}`
      this.createdTitles.push(title)
      this.sessionCreateDirs.push(directory)
      this.sessions[id] = { id }
      return { id }
    },
    async sessionPrompt(
      id: string,
      text: string,
      noReply: boolean,
      files?: Array<{ mime: string; dataUrl: string }>,
      opts?: { model?: { providerID: string; modelID: string }; directory?: string },
    ) {
      this.prompted.push({ id, text, noReply, files, model: opts?.model, directory: opts?.directory })
      if (noReply) return { parts: [] }
      return { parts: [{ type: "text", text: `AI 回复:${text}` }] }
    },
    async sessionList(_directory?: string) {
      return []
    },
    async resolveModel() {
      return this.model
    },
    async sessionInterrupt(id: string) {
      this.interrupted.push(id)
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
    expect(client.prompted.filter((p) => !p.noReply).map((p) => p.id)).toHaveLength(2)
    expect(client.prompted[1].id).toBe(client.prompted[0].id)
  })

  it("不同用户各自独立会话", async () => {
    await sm.dispatch("u1", "a")
    await sm.dispatch("u2", "b")
    const real = client.prompted.filter((p) => !p.noReply)
    expect(real[0].id).not.toBe(real[1].id)
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

  it("/status 有会话时附带待审批数（I4a）", async () => {
    const client2 = makeClient()
    const counts: Record<string, number> = { ses1: 2 }
    const sm2 = new SessionManager(
      client2,
      "/tmp/f3",
      makeFsStub() as never,
      (sid) => counts[sid] ?? 0,
    )
    await sm2.dispatch("u1", "hi")
    const reply = await sm2.dispatch("u1", "/status")
    expect(reply).toContain("当前会话: ses1")
    expect(reply).toContain("\n待审批: 2 条")
  })

  it("未注入 pendingCount 时 /status 不含待审批行且不报错（I4a 向后兼容）", async () => {
    await sm.dispatch("u1", "hi")
    const reply = await sm.dispatch("u1", "/status")
    expect(reply).not.toContain("待审批")
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

  it("snapshot 导出映射", async () => {
    await sm.dispatch("u9", "hi")
    expect(sm.snapshot()["u9"]).toBeDefined()
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

  it("dispatch 把图片透传给 bridge.sessionPrompt", async () => {
    await sm.dispatch("u7", "先建会话")
    await sm.dispatch("u7", "看图", [{ mime: "image/png", dataUrl: "data:image/png;base64,xx" }])
    expect(client.prompted.at(-1)?.files).toEqual([{ mime: "image/png", dataUrl: "data:image/png;base64,xx" }])
  })

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
    const sid = (await sm.getSessionId("u1"))!
    const reply = await sm.dispatch("u1", "/continue")
    expect(client.prompted[n]).toMatchObject({ id: sid, text: "继续" })
    expect(reply.length).toBeGreaterThan(0)
  })

  it("/retry 重发上一条非指令消息", async () => {
    await sm.dispatch("u1", "第一条")
    const n = client.prompted.filter((p) => !p.noReply).length
    await sm.dispatch("u1", "/retry")
    expect(client.prompted.filter((p) => !p.noReply)[n]).toMatchObject({ text: "第一条" })
  })

  it("/retry 无历史时提示", async () => {
    expect(await sm.dispatch("fresh", "/retry")).toContain("没有可重试的消息")
  })

  it("指令消息不记录为 lastUserText", async () => {
    await sm.dispatch("u1", "/status")
    const n = client.prompted.filter((p) => !p.noReply).length
    await sm.dispatch("u1", "/retry")
    expect(client.prompted.filter((p) => !p.noReply).length).toBe(n)
  })
})

describe("SessionManager 模型/工作区/会话切换", () => {
  const presets = [
    { id: "p/fast", label: "快速", thinking: false },
    { id: "p/deep", label: "深度", thinking: true },
  ]
  function makeOps() {
    return {
      listModels: () => presets,
      defaultModel: () => ({ providerID: "p", modelID: "fast" }),
      listWorkdirs: async () => ["D:\\A", "D:\\B"],
      listSessions: async (directory?: string) =>
        directory === "D:\\B"
          ? [{ id: "sesB1", title: "B 区会话" }]
          : [{ id: "sesA1", title: "A 区会话" }, { id: "sesA2", title: "A 区会话2" }],
    }
  }
  let client: ReturnType<typeof makeClient>
  let sm: SessionManager

  beforeEach(() => {
    client = makeClient()
    sm = new SessionManager(client, "/tmp/f", makeFsStub() as never, undefined, makeOps())
  })

  it("无 ops 时 /model 提示未配置", async () => {
    const plain = new SessionManager(client, "/tmp/f2", makeFsStub() as never)
    expect(await plain.dispatch("u1", "/model")).toContain("未配置")
  })

  it("/model 列出预设并标注当前", async () => {
    const reply = await sm.dispatch("u1", "/model")
    expect(reply).toContain("快速")
    expect(reply).toContain("深度")
    expect(reply).toContain("思考")
    expect(reply).toContain("当前")
  })

  it("/model 2 切换后 prompt 携带新模型", async () => {
    await sm.dispatch("u1", "/model 2")
    await sm.dispatch("u1", "你好")
    expect(client.prompted.at(-1)?.model).toEqual({ providerID: "p", modelID: "deep" })
  })

  it("/thinking high 切到 thinking 预设", async () => {
    await sm.dispatch("u1", "/thinking high")
    await sm.dispatch("u1", "你好")
    expect(client.prompted.at(-1)?.model).toEqual({ providerID: "p", modelID: "deep" })
  })

  it("模型选择每用户独立", async () => {
    await sm.dispatch("u1", "/model 2")
    await sm.dispatch("u2", "你好")
    expect(client.prompted.at(-1)?.model).toBeUndefined()
  })

  it("/workdir 列出与切换（切换后重置会话且新会话带目录）", async () => {
    await sm.dispatch("u1", "hi")
    const listed = await sm.dispatch("u1", "/workdir")
    expect(listed).toContain("D:\\A")
    expect(listed).toContain("D:\\B")
    const created = client.createdTitles.length
    const reply = await sm.dispatch("u1", "/workdir 2")
    expect(reply).toContain("D:\\B")
    expect(client.createdTitles.length).toBe(created) // /workdir 本身不创建
    await sm.dispatch("u1", "在新工作区说话")
    expect(client.createdTitles.length).toBe(created + 1) // 切换后重置 → 新会话
    expect(client.sessionCreateDirs.at(-1)).toBe("D:\\B")
  })

  it("/session 列出当前工作区会话并切换绑定", async () => {
    await sm.dispatch("u1", "/workdir 1")
    const listed = await sm.dispatch("u1", "/session")
    expect(listed).toContain("A 区会话")
    const reply = await sm.dispatch("u1", "/session 2")
    expect(reply).toContain("A 区会话2")
    expect(await sm.getSessionId("u1")).toBe("sesA2")
    await sm.dispatch("u1", "进这个会话说话")
    expect(client.prompted.at(-1)?.id).toBe("sesA2")
  })
})
