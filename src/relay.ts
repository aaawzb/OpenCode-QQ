import type { Hooks } from "@opencode-ai/plugin"

export interface RelayEvent {
  type: string
  properties: Record<string, unknown>
}

/**
 * 终审 I1：`tool.execute.after` 是插件 Hooks 回调而非总线事件，
 * opencode 进程不会把它投递到 plugin event 流。这里把 Hooks 回调
 * 合成总线形状事件 `{type:"tool.execute.after", properties:{sessionID, tool, title}}`
 * 交给 index.ts 的 listeners 分发，EventPusher 的既有逻辑无需改动。
 */
export function toolExecuteAfterHook(
  emit: (evt: RelayEvent) => void,
): NonNullable<Hooks["tool.execute.after"]> {
  return async (input, output) => {
    emit({
      type: "tool.execute.after",
      properties: { sessionID: input.sessionID, tool: input.tool, title: output.title },
    })
  }
}
