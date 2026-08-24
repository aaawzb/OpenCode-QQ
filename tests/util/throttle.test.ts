import { describe, expect, it, vi } from "vitest"
import { Throttler } from "../../src/util/throttle"

describe("Throttler", () => {
  it("interval 内多次 push 只 flush 一次并聚合内容", () => {
    vi.useFakeTimers()
    const flushed: string[][] = []
    const t = new Throttler(1000, (key, lines) => flushed.push([key, ...lines]))
    t.push("s1", "a")
    t.push("s1", "b")
    t.push("s2", "c")
    vi.advanceTimersByTime(1100)
    expect(flushed).toEqual([["s1", "a", "b"], ["s2", "c"]])
    vi.useRealTimers()
  })
  it("flush 后缓冲清空，下一周期可再次 flush", () => {
    vi.useFakeTimers()
    const flushed: string[] = []
    const t = new Throttler(500, (_key, lines) => flushed.push(lines.join("|")))
    t.push("k", "x")
    vi.advanceTimersByTime(600)
    t.push("k", "y")
    vi.advanceTimersByTime(600)
    expect(flushed).toEqual(["x", "y"])
    vi.useRealTimers()
  })
})
