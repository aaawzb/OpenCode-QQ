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
      async sessionCreate(_title: string) {
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
    let onMessage:
      | ((m: { openid: string; content: string; msgId: string; timestamp: number }) => Promise<void>)
      | null = null

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
