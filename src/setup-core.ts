export function mergeCredentials(existingRaw: string, creds: { appId: string; appSecret: string }): string {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(existingRaw) as Record<string, unknown>
  } catch {
    existing = {}
  }
  existing.appId = creds.appId
  existing.appSecret = creds.appSecret
  return JSON.stringify(existing, null, 2)
}
