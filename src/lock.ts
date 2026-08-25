import fs from "node:fs"

/**
 * 跨进程单实例锁。
 * 桌面版 opencode 会为每个项目实例各加载一次插件，导致 N 个网关同时收事件、
 * 用户收到 N 条重复回复。用锁文件（O_EXCL 原子创建 + mtime 心跳 + 过期接管）
 * 保证同一时刻只有一个实例运行网关。
 */
export class SingleInstanceLock {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private filePath: string,
    private staleMs = 45_000,
    private heartbeatMs = 15_000,
  ) {}

  /** 尝试获取锁；成功返回 true 并开始心跳。已持有且未过期返回 false。 */
  acquire(now = Date.now()): boolean {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ pid: process.pid, t: now }), { flag: "wx" })
    } catch {
      // 文件已存在：判断是否过期
      if (!this.isStale(now)) return false
      try {
        fs.writeFileSync(this.filePath, JSON.stringify({ pid: process.pid, t: now }))
      } catch {
        return false // 接管失败（他方正在重写），本轮放弃
      }
    }
    this.timer = setInterval(() => {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify({ pid: process.pid, t: Date.now() }))
      } catch {
        /* 刷新失败不影响持有权，下个周期再试 */
      }
    }, this.heartbeatMs)
    this.timer.unref?.()
    return true
  }

  private isStale(now = Date.now()): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { t?: number }
      const t = Number(raw.t ?? 0)
      return !Number.isFinite(t) || now - t > this.staleMs
    } catch {
      return true // 读不到/解析失败视为过期，可接管
    }
  }

  /** 释放锁（仅当仍由我们持有时删除文件）。 */
  release(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { pid?: number }
      if (raw.pid === process.pid) fs.rmSync(this.filePath, { force: true })
    } catch {
      /* 文件已不在或被他人持有 */
    }
  }
}
