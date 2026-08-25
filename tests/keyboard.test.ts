import { describe, expect, it } from "vitest"
import { buildAckKeyboard, buildApprovalKeyboard, buildReplyKeyboard, parseButtonData } from "../src/keyboard"

describe("keyboard 构造器", () => {
  it("审批键盘：两键回调流，限本人单次", () => {
    const kb = buildApprovalKeyboard(3, "USER_OPENID")
    const btns = kb.content.rows[0].buttons
    expect(btns).toHaveLength(2)
    expect(btns[0].render_data.label).toBe("同意 3")
    expect(btns[0].action).toMatchObject({
      type: 1,
      data: "approve:3",
      permission: { type: 0, specify_user_ids: ["USER_OPENID"] },
    })
    expect(btns[0].action.click_limit).toBeUndefined() // 已废弃字段不发送
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
