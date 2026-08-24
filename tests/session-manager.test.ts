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
})
