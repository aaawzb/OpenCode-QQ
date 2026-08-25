import { describe, expect, it } from "vitest"
import { parseCommand } from "../src/commands"

describe("parseCommand", () => {
  it("识别 /new /status /help（忽略大小写与首尾空白）", () => {
    expect(parseCommand(" /new")).toEqual({ type: "new" })
    expect(parseCommand("/STATUS")).toEqual({ type: "status" })
    expect(parseCommand("/help")).toEqual({ type: "help" })
  })
  it("识别 /interrupt /continue /retry", () => {
    expect(parseCommand("/interrupt")).toEqual({ type: "interrupt" })
    expect(parseCommand("/continue")).toEqual({ type: "continue" })
    expect(parseCommand("/retry")).toEqual({ type: "retry" })
  })
  it("带参数指令：/model /thinking /workdir /session", () => {
    expect(parseCommand("/model")).toEqual({ type: "model", arg: undefined })
    expect(parseCommand("/model 2")).toEqual({ type: "model", arg: "2" })
    expect(parseCommand("/thinking high")).toEqual({ type: "thinking", arg: "high" })
    expect(parseCommand("/workdir 1")).toEqual({ type: "workdir", arg: "1" })
    expect(parseCommand("/session 3")).toEqual({ type: "session", arg: "3" })
  })
  it("非指令或未知指令返回 null", () => {
    expect(parseCommand("你好")).toBeNull()
    expect(parseCommand("/unknown")).toBeNull()
    expect(parseCommand("/new2")).toBeNull()
    expect(parseCommand("/model abc")).toBeNull() // 参数必须为序号或档位词
  })
})
