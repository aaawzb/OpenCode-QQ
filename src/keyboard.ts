export interface QQButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: {
    type: number
    permission: { type: number; specify_role_ids: string[]; specify_user_ids: string[] }
    data: string
    enter?: boolean
  }
}

export interface QQKeyboard {
  content: { rows: Array<{ buttons: QQButton[] }> }
}

function button(
  id: string,
  label: string,
  data: string,
  type: number,
  _openid: string,
  enter?: boolean,
): QQButton {
  return {
    id,
    render_data: { label, visited_label: label, style: 0 },
    action: {
      type,
      // 单聊场景用"所有人"权限：实际只有对话双方能点。
      // type=0 指定用户会导致客户端点击时提示"无权限操作"（实测）
      permission: { type: 2, specify_role_ids: [], specify_user_ids: [] },
      data,
      ...(enter !== undefined ? { enter } : {}),
    },
  }
}

const keyboard = (...buttons: QQButton[]): QQKeyboard => ({ content: { rows: [{ buttons }] } })

/** 审批键盘：同意/拒绝两键，回调流（type=1），data 供 INTERACTION_CREATE 路由 */
export function buildApprovalKeyboard(seq: number, openid: string): QQKeyboard {
  return keyboard(
    button(`approve-${seq}`, `同意 ${seq}`, `approve:${seq}`, 1, openid),
    button(`reject-${seq}`, `拒绝 ${seq}`, `reject:${seq}`, 1, openid),
  )
}

/** ack 回执键盘：中断当前任务（指令流） */
export function buildAckKeyboard(openid: string): QQKeyboard {
  return keyboard(button("ack-interrupt", "中断", "/interrupt", 2, openid, true))
}

/** AI 回复键盘：新会话 / 状态（指令流） */
export function buildReplyKeyboard(openid: string): QQKeyboard {
  return keyboard(
    button("reply-new", "新会话", "/new", 2, openid, true),
    button("reply-status", "状态", "/status", 2, openid, true),
  )
}

export interface ButtonData {
  action: "approve" | "reject"
  seq: number
}

/** 解析回调流按钮的 data 字段（approve:N / reject:N） */
export function parseButtonData(data: string): ButtonData | null {
  const m = /^(approve|reject):(\d+)$/.exec(data)
  return m ? { action: m[1] as "approve" | "reject", seq: Number(m[2]) } : null
}

const sm = (name: string, send: string) => ({ type: "send_message", name, send_message: send })

/** 默认自定义菜单面板（单聊窗口底部）：点击自动填入指令，走现有指令系统 */
export function buildDefaultMenuPanel(): unknown {
  return {
    items: [
      sm("帮助", "/help"),
      sm("新会话", "/new"),
      {
        type: "menu",
        name: "模型",
        sub_menu_items: [
          sm("切换模型", "/model"),
          sm("深度思考", "/thinking high"),
          sm("快速模式", "/thinking low"),
        ],
      },
      {
        type: "menu",
        name: "更多",
        sub_menu_items: [
          sm("状态", "/status"),
          sm("工作区", "/workdir"),
          sm("切换会话", "/session"),
          sm("中断任务", "/interrupt"),
        ],
      },
    ],
  }
}
