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
    toolProgressIntervalMs: 10,
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

  it("session.error 的结构化错误取 data.message 而非 [object Object]（I2）", async () => {
    const { emit, sent } = makeDeps()
    emit("session.error", {
      sessionID: "ours3",
      error: { name: "UnknownError", data: { message: "磁盘已满" } },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("磁盘已满")
    expect(sent[0].text).not.toContain("[object Object]")
  })

  it("结构化错误缺 data.message 时回退 error.name，再回退 String(error)（I2）", async () => {
    const { emit, sent } = makeDeps()
    emit("session.error", { sessionID: "ours4", error: { name: "APIError" } })
    emit("session.error", { sessionID: "ours5", error: 42 })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[0].text).toContain("APIError")
    expect(sent[1].text).toContain("42")
  })

  it("超长错误摘要截断到 300 字符（I2）", async () => {
    const { emit, sent } = makeDeps()
    emit("session.error", {
      sessionID: "ours6",
      error: { name: "UnknownError", data: { message: "x".repeat(500) } },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const body = sent[0].text.split("❌ 出错: ")[1]
    expect(body).toHaveLength(300)
  })

  it("session.idle 附带最后回复摘要（尾部 200 字符）（I4b）", async () => {
    const last = "A".repeat(300) + "END"
    let handler: Handler = () => {}
    const sent: Array<{ openid: string; text: string }> = []
    new EventPusher({
      isOurSession: (id) => id.startsWith("ours"),
      openidOfSession: (id) => (id.startsWith("ours") ? `u-${id.slice(4)}` : null),
      send: async (openid, text) => void sent.push({ openid, text }),
      subscribe: (h) => {
        handler = h
      },
      toolProgress: true,
      lastAssistantText: (sid) => (sid === "ours7" ? last : null),
    })
    handler({ type: "session.idle", properties: { sessionID: "ours7" } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("✅ 任务完成。")
    expect(sent[0].text).toContain("\n摘要: ")
    const summary = sent[0].text.split("\n摘要: ")[1]
    // 尾部 200 字符："A".repeat(197) + "END"，更早的 103 个 A 被截掉
    expect(summary).toBe("A".repeat(197) + "END")
    expect(summary.length).toBe(200)
  })

  it("无摘要（lastAssistantText 缺省或返回 null）时 idle 推送保持原样（I4b）", async () => {
    let handler: Handler = () => {}
    const sent: Array<{ openid: string; text: string }> = []
    new EventPusher({
      isOurSession: (id) => id.startsWith("ours"),
      openidOfSession: (id) => (id.startsWith("ours") ? `u-${id.slice(4)}` : null),
      send: async (openid, text) => void sent.push({ openid, text }),
      subscribe: (h) => {
        handler = h
      },
      toolProgress: true,
    })
    handler({ type: "session.idle", properties: { sessionID: "ours8" } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toBe("✅ 任务完成。")
  })
})
