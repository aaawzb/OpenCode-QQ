import { describe, expect, it } from "vitest"
import {
  buildAckKeyboard,
  buildApprovalKeyboard,
  buildDefaultMenuPanel,
  buildReplyKeyboard,
  parseButtonData,
} from "../src/keyboard"

describe("keyboard 构造器", () => {
  it("审批键盘：两键回调流，限本人单次", () => {
    const kb = buildApprovalKeyboard(3, "USER_OPENID")
    const btns = kb.content.rows[0].buttons
    expect(btns).toHaveLength(2)
    expect(btns[0].render_data.label).toBe("同意 3")
    expect(btns[0].action).toMatchObject({
      type: 1,
      data: "approve:3",
      // 单聊场景用"所有人"权限（实际只有对话双方能点）；type=0 指定用户会导致客户端提示无权限
      permission: { type: 2, specify_user_ids: [] },
    })
    expect(btns[0].action.click_limit).toBeUndefined() // 已废弃字段不发送
    expect(btns[1].render_data.label).toBe("拒绝 3")
    expect(btns[1].action.data).toBe("reject:3")
  })
  it("ack 键盘：单【中断】指令按钮", () => {
    const kb = buildAckKeyboard("USER_OPENID")
    const b = kb.content.rows[0].buttons[0]
    expect(b.render_data.label).toBe("中断")
    expect(b.action).toMatchObject({ type: 2, enter: true, data: "/interrupt" })
  })
  it("回复键盘：【新会话】【状态】指令按钮", () => {
    const kb = buildReplyKeyboard("USER_OPENID")
    const labels = kb.content.rows[0].buttons.map((b) => b.render_data.label)
    expect(labels).toEqual(["新会话", "状态"])
    expect(kb.content.rows[0].buttons[0].action.data).toBe("/new")
    expect(kb.content.rows[0].buttons[1].action.data).toBe("/status")
  })
  it("parseButtonData 编解码往返", () => {
    expect(parseButtonData("approve:3")).toEqual({ action: "approve", seq: 3 })
    expect(parseButtonData("reject:12")).toEqual({ action: "reject", seq: 12 })
    expect(parseButtonData("junk")).toBeNull()
    expect(parseButtonData("approve:x")).toBeNull()
  })
  it("默认菜单面板：帮助/新会话 + 模型与更多折叠项", () => {
    const menu = buildDefaultMenuPanel() as {
      items: Array<{
        type: string
        name: string
        send_message?: string
        sub_menu_items?: Array<{ type: string; name: string; send_message?: string }>
      }>
    }
    expect(menu.items).toHaveLength(4)
    expect(menu.items[0]).toEqual({ type: "send_message", name: "帮助", send_message: "/help" })
    expect(menu.items[1]).toEqual({ type: "send_message", name: "新会话", send_message: "/new" })
    const modelMenu = menu.items[2]
    expect(modelMenu.type).toBe("menu")
    expect(modelMenu.name).toBe("模型")
    expect(modelMenu.sub_menu_items?.map((s) => s.send_message)).toEqual([
      "/model",
      "/thinking high",
      "/thinking low",
    ])
    const moreMenu = menu.items[3]
    expect(moreMenu.sub_menu_items?.map((s) => s.send_message)).toEqual([
      "/status",
      "/workdir",
      "/session",
      "/interrupt",
    ])
    // 名称长度限制：主菜单 10 字符、子菜单 14 字符
    for (const item of menu.items) {
      expect(item.name.length).toBeLessThanOrEqual(10)
      for (const sub of item.sub_menu_items ?? []) expect(sub.name.length).toBeLessThanOrEqual(14)
    }
  })
})
