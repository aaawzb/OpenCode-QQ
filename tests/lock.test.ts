import fs from "node:fs"
import os from "node:os"
import { describe, expect, it } from "vitest"
import { SingleInstanceLock } from "../src/lock"

const dir = fs.mkdtempSync(`${os.tmpdir()}/qqlock-`)
const lockPath = `${dir}/opencode-qq.lock`

describe("SingleInstanceLock", () => {
  it("首次获取成功，二次获取失败", () => {
    const a = new SingleInstanceLock(lockPath)
    const b = new SingleInstanceLock(lockPath)
    expect(a.acquire()).toBe(true)
    expect(b.acquire()).toBe(false)
    a.release()
  })

  it("释放后他人可获取", () => {
    const a = new SingleInstanceLock(lockPath)
    const b = new SingleInstanceLock(lockPath)
    a.acquire()
    a.release()
    expect(b.acquire()).toBe(true)
    b.release()
  })

  it("过期锁可被接管", () => {
    const a = new SingleInstanceLock(lockPath)
    const b = new SingleInstanceLock(lockPath, 1000)
    a.acquire(1_000_000) // 远古时间戳 → 立即过期
    expect(b.acquire(2_000_000)).toBe(true)
    b.release()
  })

  it("release 只删除自己写的锁文件", () => {
    const a = new SingleInstanceLock(lockPath)
    const b = new SingleInstanceLock(lockPath)
    a.acquire()
    fs.writeFileSync(lockPath, JSON.stringify({ pid: -1, t: 0 })) // 模拟被他人接管覆盖
    a.release()
    expect(fs.existsSync(lockPath)).toBe(true) // 不误删他人锁
    b.release()
  })
})
