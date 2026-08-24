import { describe, expect, it, vi } from "vitest"
// 对齐 @opencode-ai/plugin Hooks 接口："tool.execute.after"(input:{tool,sessionID,callID,args}, output:{title,output,metadata})
import { toolExecuteAfterHook } from "../src/relay"

type Handler = (evt: { type: string; properties: Record<string, unknown> }) => void

describe("tool.execute.after 钩子接线（I1：工具进度死开关）", () => {
  it("钩子回调合成总线事件交给 listeners，EventPusher 据此节流推送", async () => {
    const sent: Array<{ openid: string; text: string }> = []
    const listeners: Handler[] = []
    const { EventPusher } = await import("../src/event-pusher")
    new EventPusher({
      isOurSession: (id) => id.startsWith("ours"),
      openidOfSession: (id) => (id.startsWith("ours") ? `u-${id.slice(4)}` : null),
      send: async (openid, text) => void sent.push({ openid, text }),
      subscribe: (h) => void listeners.push(h),
      toolProgress: true,
      toolProgressIntervalMs: 10,
    })

    const hook = toolExecuteAfterHook((e) => {
      for (const h of listeners) h(e)
    })

    // 真实 Hooks 回调形状
    await hook(
      { tool: "bash", sessionID: "ours9", callID: "call-1", args: { cmd: "npm build" } },
      { title: "npm build", output: "done", metadata: {} },
    )
    await hook(
      { tool: "read", sessionID: "ours9", callID: "call-2", args: {} },
      { title: "src/a.ts", output: "...", metadata: {} },
    )

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).toContain("bash: npm build")
    expect(sent[0].text).toContain("read: src/a.ts")
    expect(sent[0].openid).toBe("u-9")
  })

  it("合成事件形状为 {type:'tool.execute.after', properties:{sessionID,tool,title}}", async () => {
    const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
    const hook = toolExecuteAfterHook((e) => void seen.push(e))
    await hook({ tool: "edit", sessionID: "ses-x", callID: "c", args: null }, { title: "t.ts", output: "", metadata: null })
    expect(seen).toEqual([
      { type: "tool.execute.after", properties: { sessionID: "ses-x", tool: "edit", title: "t.ts" } },
    ])
  })
})
