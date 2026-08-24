type FlushFn = (key: string, lines: string[]) => void

export class Throttler {
  private buffers = new Map<string, string[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private intervalMs: number, private flush: FlushFn) {}

  push(key: string, line: string): void {
    let buf = this.buffers.get(key)
    if (!buf) {
      buf = []
      this.buffers.set(key, buf)
      this.timers.set(
        key,
        setTimeout(() => this.flushKey(key), this.intervalMs),
      )
    }
    buf.push(line)
  }

  private flushKey(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    const buf = this.buffers.get(key)
    this.buffers.delete(key)
    if (buf && buf.length > 0) this.flush(key, buf)
  }

  dispose(): void {
    for (const key of [...this.buffers.keys()]) this.flushKey(key)
  }
}
