import { TOKEN_URL } from "../constants.js"

export class AuthManager {
  private token: string | null = null
  private expireAt = 0

  constructor(
    private appId: string,
    private appSecret: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.expireAt - 60_000) return this.token
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    if (!res.ok) throw new Error(`getAppAccessToken failed: HTTP ${res.status}`)
    const data = (await res.json()) as { access_token: string; expires_in: string | number }
    this.token = data.access_token
    this.expireAt = Date.now() + Number(data.expires_in) * 1000
    return this.token
  }
}
