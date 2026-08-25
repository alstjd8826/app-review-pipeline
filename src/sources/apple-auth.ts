/**
 * App Store Connect ES256 JWT 인증.
 * GUIDEBOOK.md 2.2 — Play(RS256)와 알고리즘도 payload 도 다르다.
 */
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'

const AUD = 'appstoreconnect-v1'
/** Apple 은 20분을 넘는 토큰을 거부한다. 여유를 두고 15분 */
const TTL_SECONDS = 900

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export type AppleKeyKind = 'individual' | 'team'

export interface AppleAuthOptions {
  /** .p8 파일 경로 */
  p8Path: string
  keyId: string
  /**
   * 개별 키는 iss 를 쓰지 않고 sub:"user" 를 쓴다.
   * 팀 키만 issuerId 가 필요하다.
   */
  kind: AppleKeyKind
  issuerId?: string
}

export class AppleAuth {
  private privateKey: string
  private keyId: string
  private kind: AppleKeyKind
  private issuerId?: string
  private cached?: { token: string; expiresAt: number }

  constructor(opts: AppleAuthOptions) {
    if (opts.kind === 'team' && !opts.issuerId) {
      throw new Error('팀 키에는 issuerId 가 필요하다')
    }
    this.privateKey = readFileSync(opts.p8Path, 'utf8')
    this.keyId = opts.keyId
    this.kind = opts.kind
    this.issuerId = opts.issuerId
  }

  token(): string {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token

    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.keyId, typ: 'JWT' }))

    // ⚠️ 여기서 개별 키와 팀 키가 갈린다. 섞으면 401 만 본다
    const payload =
      this.kind === 'individual'
        ? { sub: 'user', aud: AUD, iat: now, exp: now + TTL_SECONDS }
        : { iss: this.issuerId, aud: AUD, iat: now, exp: now + TTL_SECONDS }

    const signingInput = `${header}.${b64url(JSON.stringify(payload))}`

    // ⚠️ 기본값인 DER 로 서명하면 401 이다. IEEE P1363(r‖s) 이어야 한다
    const signer = createSign('SHA256')
    signer.update(signingInput)
    const signature = signer.sign({ key: this.privateKey, dsaEncoding: 'ieee-p1363' })

    const token = `${signingInput}.${b64url(signature)}`
    this.cached = { token, expiresAt: Date.now() + TTL_SECONDS * 1000 }
    return token
  }
}
