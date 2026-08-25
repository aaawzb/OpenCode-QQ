import { TOKEN_URL } from "../constants.js"
import { qqLog } from "../errors.js"

interface TokenBody {
  access_token?: string
  expires_in?: string | number
  err_code?: unknown
  code?: unknown
  message?: unknown
}

export class AuthManager {
  private token: string | null = null
  private expireAt = 0
  private inflight: Promise<string> | null = null

  constructor(
    private appId: string,
    private appSecret: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.expireAt - 60_000) return this.token
    if (this.inflight) return this.inflight
    this.inflight = this.requestToken().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async requestToken(retry = true): Promise<string> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    if (!res.ok) {
      qqLog("auth", "AUTH_HTTP", `HTTP ${res.status}`)
      throw new Error(`getAppAccessToken failed: HTTP ${res.status}`)
    }
    const text = await res.text()
    let data: TokenBody
    try {
      data = JSON.parse(text) as TokenBody
    } catch {
      data = {}
    }
    if (!data.access_token) {
      return this.handleBadBody(data, text, retry)
    }
    this.token = data.access_token
    this.expireAt = Date.now() + Number(data.expires_in) * 1000
    return this.token
  }

  /** HTTP 200 但 body 缺 access_token：按 err_code 分类记录后抛错；100001 延迟 1s 重试一次 */
  private async handleBadBody(data: TokenBody, rawText: string, retry: boolean): Promise<string> {
    const msg = typeof data.message === "string" ? data.message : ""
    const raw = data.err_code ?? data.code
    const ec = raw === undefined || raw === null || raw === "" ? "" : String(raw)
    if (ec === "100001") {
      qqLog("auth", "AUTH_RATE", msg)
      if (retry) {
        await new Promise((r) => setTimeout(r, 1_000))
        return this.requestToken(false)
      }
    } else if (ec === "100007" || ec === "10004") {
      qqLog("auth", "AUTH_APPID", `${ec} ${msg}`.trim())
    } else if (ec === "100016") {
      qqLog("auth", "AUTH_SECRET", msg)
    } else if (ec !== "") {
      qqLog("auth", "AUTH_UNKNOWN", `${ec} ${msg}`.trim())
    } else {
      qqLog("auth", "AUTH_BODY", rawText)
    }
    const reason = ec !== "" ? `err_code=${ec}${msg ? ` ${msg}` : ""}` : rawText || "empty body"
    throw new Error(`getAppAccessToken failed: no access_token in response (${reason})`)
  }
}
