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
  openid: string,
  enter?: boolean,
): QQButton {
  return {
    id,
    render_data: { label, visited_label: label, style: 0 },
    action: {
      type,
      // 官方语义：0=指定用户（配合 specify_user_ids），1=管理员，2=所有人
      permission: { type: 0, specify_role_ids: [], specify_user_ids: [openid] },
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
  return keyboard(button("ack-interrupt", "⏹ 中断", "/interrupt", 2, openid, true))
}

/** AI 回复键盘：新会话 / 状态（指令流） */
export function buildReplyKeyboard(openid: string): QQKeyboard {
  return keyboard(
    button("reply-new", "➕ 新会话", "/new", 2, openid, true),
    button("reply-status", "📊 状态", "/status", 2, openid, true),
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
