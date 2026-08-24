import { describe, expect, it } from "vitest"
// 对齐真实 SDK 事件类型（node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts）：
// EventMessagePartUpdated.properties = { part: Part; delta?: string }
// EventMessageUpdated.properties = { info: Message }（Message 带 role 字段）
import type { EventMessagePartUpdated, EventMessageUpdated } from "@opencode-ai/sdk"
import { AssistantTextBuffer } from "../src/stream-buffer"

const assistantReady = (): EventMessageUpdated => ({
  type: "message.updated",
  properties: {
    info: {
      id: "m-assist",
      sessionID: "s1",
      role: "assistant",
      time: { created: Date.now() },
      parentID: "m-user",
      modelID: "claude-test",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
})

const userReady = (id = "m-user"): EventMessageUpdated => ({
  type: "message.updated",
  properties: {
    info: {
      id,
      sessionID: "s1",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-test" },
    },
  },
})

const partEvent = (
  part: Partial<EventMessagePartUpdated["properties"]["part"]> & {
    id: string
    messageID: string
    text: string
    type: "text"
  },
  delta?: string,
): EventMessagePartUpdated => ({
  type: "message.part.updated",
  properties: {
    part: { sessionID: "s1", ...part } as EventMessagePartUpdated["properties"]["part"],
    ...(delta === undefined ? {} : { delta }),
  },
})

function makeBuffer(isOurs: (sid: string) => boolean = () => true) {
  const buf = new AssistantTextBuffer(isOurs)
  const feed = (...events: Array<EventMessagePartUpdated | EventMessageUpdated>) => {
    for (const e of events) buf.handle(e)
  }
  return { buf, feed }
}

describe("AssistantTextBuffer（C1：流式增量语义）", () => {
  it("delta 存在时按增量累计（part 为快照不参与拼接）", () => {
    const { buf, feed } = makeBuffer()
    feed(
      assistantReady(),
      partEvent({ id: "p1", messageID: "m-assist", text: "你", type: "text" }, "你"),
      partEvent({ id: "p1", messageID: "m-assist", text: "你好", type: "text" }, "好"),
    )
    expect(buf.text("s1")).toBe("你好")
  })

  it("delta 缺失时按 part.id 快照替换而非拼接", () => {
    const { buf, feed } = makeBuffer()
    feed(
      assistantReady(),
      partEvent({ id: "p1", messageID: "m-assist", text: "你", type: "text" }),
      partEvent({ id: "p1", messageID: "m-assist", text: "你好", type: "text" }),
      partEvent({ id: "p1", messageID: "m-assist", text: "你好，世界", type: "text" }),
    )
    expect(buf.text("s1")).toBe("你好，世界")
  })

  it("用户消息的 TextPart 不入缓冲（role=user 过滤）", () => {
    const { buf, feed } = makeBuffer()
    feed(
      userReady(),
      assistantReady(),
      partEvent({ id: "pu1", messageID: "m-user", text: "帮我写脚本", type: "text" }, "帮我写脚本"),
      partEvent({ id: "pa1", messageID: "m-assist", text: "好的", type: "text" }, "好的"),
    )
    expect(buf.text("s1")).toBe("好的")
  })

  it("messageID 未在 message.updated 跟踪到的文本一律丢弃（保守防污染）", () => {
    const { buf, feed } = makeBuffer()
    feed(partEvent({ id: "px", messageID: "m-unknown", text: "神秘文本", type: "text" }, "神秘文本"))
    expect(buf.text("s1")).toBeNull()
  })

  it("sessionID 取自 part.sessionID（properties 无顶层 sessionID，对齐 SDK）", () => {
    const { buf, feed } = makeBuffer()
    feed(assistantReady())
    const e = partEvent({ id: "p1", messageID: "m-assist", text: "ok", type: "text" }, "ok")
    expect(Object.keys(e.properties).sort()).toEqual(["delta", "part"]) // 真实事件形状
    feed(e)
    expect(buf.text("s1")).toBe("ok")
  })

  it("非文本 part（tool 等）忽略；多文本 part 按出现顺序拼接", () => {
    const { buf, feed } = makeBuffer()
    feed(
      assistantReady(),
      partEvent({ id: "pt", messageID: "m-assist", text: "", type: "tool" as never }),
      partEvent({ id: "p1", messageID: "m-assist", text: "A", type: "text" }, "A"),
      partEvent({ id: "p2", messageID: "m-assist", text: "B", type: "text" }, "B"),
    )
    expect(buf.text("s1")).toBe("AB")
  })

  it("非本插件会话不入缓冲；clear 清空指定会话", () => {
    const { buf, feed } = makeBuffer((sid) => sid === "ours")
    feed(assistantReady(), partEvent({ id: "p1", messageID: "m-assist", text: "x", type: "text" }, "x"))
    expect(buf.text("s1")).toBeNull() // s1 不属于本插件
    buf.clear("s1") // 不抛错即可
    expect(buf.text("s1")).toBeNull()
  })
})
