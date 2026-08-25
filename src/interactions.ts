import { qqLog } from "./errors.js"
import { parseButtonData } from "./keyboard.js"

export interface InteractionEvt {
  id: string
  type: number
  buttonData: string
  buttonId: string
  userOpenid: string
}

export interface InteractionDeps {
  /** 应答互动事件（3 秒窗口内，先于一切业务动作） */
  put(interactionId: string, code: number): Promise<void>
  /** 查询待审请求；命中返回 { permissionId, sessionId } */
  confirm(seq: number): { permissionId: string; sessionId: string } | undefined
  /** 代答 opencode 权限请求 */
  respond(sessionId: string, permissionId: string, reply: "once" | "reject"): Promise<void>
  /** 以互动事件 id 为 event_id 发被动消息（结果反馈） */
  sendViaEvent(openid: string, eventId: string, text: string): Promise<void>
}

/**
 * 处理 INTERACTION_CREATE（按钮点击）。
 * 铁律：先 PUT code=0 应答（保 3 秒窗口），再做任何业务动作；
 * 业务结果通过 event_id 被动消息反馈给用户。
 */
export async function handleInteraction(evt: InteractionEvt, deps: InteractionDeps): Promise<void> {
  try {
    await deps.put(evt.id, 0)
    if (evt.type !== 11) return // 仅消息按钮需要业务路由
    const parsed = parseButtonData(evt.buttonData)
    if (!parsed) {
      qqLog("interactions", "KB_UNKNOWN", evt.buttonData)
      return
    }
    const item = deps.confirm(parsed.seq)
    if (!item) {
      await deps.put(evt.id, 3) // 重复操作：编号已处理或超时
      await deps.sendViaEvent(evt.userOpenid, evt.id, `#${parsed.seq} 已失效（已处理或超时）`)
      return
    }
    const reply = parsed.action === "approve" ? "once" : "reject"
    await deps.respond(item.sessionId, item.permissionId, reply)
    await deps.sendViaEvent(
      evt.userOpenid,
      evt.id,
      parsed.action === "approve" ? `已批准 #${parsed.seq} ✓` : `已拒绝 #${parsed.seq}`,
    )
  } catch (e) {
    qqLog("interactions", "INT001", String(e).slice(0, 200))
  }
}
