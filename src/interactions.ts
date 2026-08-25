import { qqLog } from "./errors.js"
import { parseButtonData } from "./keyboard.js"

export interface InteractionEvt {
  id: string
  type: number
  buttonData: string
  buttonId: string
  /** 快捷菜单（type=12）的功能 ID */
  featureId: string
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
  /** 可选：管理端菜单 featureId → 动作串（如 "model:2"、"new"）映射 */
  resolveAction?(featureId: string): string | undefined
  /** 可选：以指令文本驱动会话动作（菜单动作的执行通道） */
  runCommand?(openid: string, commandText: string): Promise<string>
  /** 可选：诊断日志（写入 opencode 实例日志，便于排查按钮问题） */
  log?(level: "info" | "warn" | "error", message: string): void
}

/**
 * 处理 INTERACTION_CREATE（按钮点击 / 快捷菜单）。
 * 铁律：先 PUT code=0 应答（保 3 秒窗口），再做任何业务动作；
 * 业务结果通过 event_id 被动消息反馈给用户。
 */
export async function handleInteraction(evt: InteractionEvt, deps: InteractionDeps): Promise<void> {
  const log = (level: "info" | "warn" | "error", message: string) =>
    tryLog(deps.log, level, `interaction type=${evt.type} id=${evt.id.slice(0, 8)} :: ${message}`)
  try {
    log("info", `收到互动事件, buttonData=${evt.buttonData || "(空)"}, featureId=${evt.featureId || "(空)"}`)
    await deps.put(evt.id, 0)
    if (evt.type === 12) {
      // 快捷菜单：featureId → 配置映射的动作串 → 指令通道执行
      const action = deps.resolveAction?.(evt.featureId)
      if (!action) {
        qqLog("interactions", "KB_UNKNOWN", `featureId=${evt.featureId} 未在 menus 中配置`)
        return
      }
      const reply = await deps.runCommand?.(evt.userOpenid, `/${action.replace(/^\//, "")}`)
      if (reply) await deps.sendViaEvent(evt.userOpenid, evt.id, reply)
      return
    }
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
    qqLog("interactions", "INT_HANDLE_FAIL", String(e).slice(0, 200))
    tryLog(deps.log, "error", `处理异常: ${String(e).slice(0, 200)}`)
  }
}

function tryLog(
  log: ((level: "info" | "warn" | "error", message: string) => void) | undefined,
  level: "info" | "warn" | "error",
  message: string,
): void {
  try {
    log?.(level, message)
  } catch {
    /* 日志失败不影响主流程 */
  }
}
