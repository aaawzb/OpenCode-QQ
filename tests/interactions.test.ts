import { describe, expect, it, vi } from "vitest"
import { handleInteraction, type InteractionDeps } from "../src/interactions"

function makeDeps(pending: Map<number, { permissionId: string; sessionId: string }>) {
  const puts: Array<{ id: string; code: number }> = []
  const sent: Array<{ openid: string; text: string; eventId: string }> = []
  const approved: Array<{ sessionId: string; permissionId: string; reply: string }> = []
  const deps: InteractionDeps = {
    put: async (id, code) => void puts.push({ id, code }),
    confirm: (seq) => pending.get(seq),
    respond: async (sessionId, permissionId, reply) => void approved.push({ sessionId, permissionId, reply }),
    sendViaEvent: async (openid, eventId, text) => void sent.push({ openid, eventId, text }),
  }
  return { deps, puts, sent, approved }
}

const evt = (buttonData: string) => ({
  id: "IID",
  type: 11,
  buttonData,
  buttonId: "b",
  userOpenid: "U1",
})

describe("handleInteraction", () => {
  it("approve：先 PUT 0，代答 once，event_id 回执", async () => {
    const pending = new Map([[3, { permissionId: "p1", sessionId: "s1" }]])
    const { deps, puts, sent, approved } = makeDeps(pending)
    await handleInteraction(evt("approve:3"), deps)
    expect(puts[0]).toEqual({ id: "IID", code: 0 })
    expect(approved).toEqual([{ sessionId: "s1", permissionId: "p1", reply: "once" }])
    expect(sent[0]).toMatchObject({ openid: "U1", eventId: "IID" })
    expect(sent[0].text).toContain("已批准 #3")
  })
  it("reject 代答 reject 并回执", async () => {
    const pending = new Map([[5, { permissionId: "p", sessionId: "s" }]])
    const { deps, sent, approved } = makeDeps(pending)
    await handleInteraction(evt("reject:5"), deps)
    expect(approved[0].reply).toBe("reject")
    expect(sent[0].text).toContain("已拒绝 #5")
  })
  it("编号不存在：PUT code=3 并提示失效", async () => {
    const { deps, puts, sent } = makeDeps(new Map())
    await handleInteraction(evt("approve:9"), deps)
    expect(puts[1]).toEqual({ id: "IID", code: 3 })
    expect(sent[0].text).toContain("#9 已失效")
  })
  it("未知 buttonData：仅 PUT 0，不发送消息", async () => {
    const { deps, puts, sent } = makeDeps(new Map())
    await handleInteraction(evt("junk"), deps)
    expect(puts).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })
})
