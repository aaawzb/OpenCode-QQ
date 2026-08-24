import { describe, expect, it, vi } from "vitest"
import { Approver } from "../src/approver"

describe("Approver", () => {
  it("register 分配自增编号并生成提示文本", () => {
    const a = new Approver(10_000)
    const n = a.register("ses1", "perm1", "执行命令: npm test")
    expect(n).toBe(1)
    const text = a.render(n)
    expect(text).toContain("#1")
    expect(text).toContain("npm test")
    expect(text).toContain("同意 1")
  })

  it("解析 同意/拒绝 回复（容忍大小写、空白）", () => {
    const a = new Approver(10_000)
    a.register("s", "p", "t")
    expect(a.parseReply("同意 1")).toEqual({ seq: 1, reply: "once" })
    expect(a.parseReply("拒绝1")).toEqual({ seq: 1, reply: "reject" })
    expect(a.parseReply("随便说说")).toBeNull()
  })

  it("confirm 取出待审项并移除", () => {
    const a = new Approver(10_000)
    const seq = a.register("s", "permX", "t")
    expect(a.confirm(seq)?.permissionId).toBe("permX")
    expect(a.confirm(seq)).toBeUndefined()
  })

  it("超时后条目被清理", () => {
    vi.useFakeTimers()
    const a = new Approver(100)
    const seq = a.register("s", "p", "t")
    vi.advanceTimersByTime(150)
    expect(a.confirm(seq)).toBeUndefined()
    vi.useRealTimers()
  })
})
