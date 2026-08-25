/**
 * 서비스 계정 JWT 인증. 외부 의존성 없이 Node 내장 crypto 만 쓴다.
 * GUIDEBOOK.md 4.2
 */
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'

export const SCOPE_ANDROID_PUBLISHER = 'https://www.googleapis.com/auth/androidpublisher'
export const SCOPE_STORAGE_READ = 'https://www.googleapis.com/auth/devstorage.read_only'

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export class GoogleAuth {
  private readonly sa: ServiceAccount
  /** 스코프별 토큰 캐시. 만료 60초 전에 갱신한다 */
  private cache = new Map<string, { token: string; expiresAt: number }>()

  constructor(credentialsPath: string) {
    this.sa = JSON.parse(readFileSync(credentialsPath, 'utf8'))
  }

  get clientEmail() {
    return this.sa.client_email
  }

  async token(scopes: string[]): Promise<string> {
    const key = scopes.slice().sort().join(' ')
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token

    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = b64url(
      JSON.stringify({
        iss: this.sa.client_email,
        scope: key,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    )
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const assertion = `${header}.${claims}.${b64url(signer.sign(this.sa.private_key))}`

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
    if (!res.ok || !body.access_token) {
      throw new Error(`토큰 발급 실패 ${res.status}: ${body.error_description ?? body.error}`)
    }

    this.cache.set(key, { token: body.access_token, expiresAt: Date.now() + 3600_000 })
    return body.access_token
  }
}
