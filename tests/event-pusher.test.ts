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
})
