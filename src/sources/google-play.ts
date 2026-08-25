/**
 * Google Play 소스 어댑터.
 *
 * 주의 — 이 플랫폼의 두 가지 제약이 설계를 결정한다 (GUIDEBOOK.md 2.1)
 *   1. reviews.list 는 최근 7일치만 준다. 과거는 리포트 버킷 CSV 로만 받는다.
 *   2. 답변은 350자를 넘을 수 없다.
 */
import { GoogleAuth, SCOPE_ANDROID_PUBLISHER, SCOPE_STORAGE_READ } from './google-auth.js'
import { parseReviewsCsv } from './play-csv.js'
import type { FetchResult, RawReview, ReviewSource, SourceConstraints } from '../core/types.js'

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
const STORAGE = 'https://storage.googleapis.com/storage/v1'

/** reviews.list 응답 중 우리가 쓰는 부분만 */
interface PlayComment {
  userComment?: {
    text?: string
    lastModified?: { seconds: string }
    starRating?: number
    reviewerLanguage?: string
    device?: string
    appVersionName?: string
  }
  developerComment?: {
    text?: string
    lastModified?: { seconds: string }
  }
}
interface PlayReview {
  reviewId: string
  comments?: PlayComment[]
}

const secondsToDate = (s?: string) => (s ? new Date(Number(s) * 1000) : new Date(0))

export interface GooglePlayOptions {
  packageName: string
  credentialsPath: string
  /** gs://pubsite_prod_rev_... 또는 버킷 이름만 */
  reportBucket?: string
}

export class GooglePlaySource implements ReviewSource {
  readonly id = 'google-play'
  readonly constraints: SourceConstraints = {
    maxReplyLength: 350,
    retentionDays: 7,
    replyEditable: true,
  }

  private auth: GoogleAuth
  private packageName: string
  private bucket?: string

  constructor(opts: GooglePlayOptions) {
    this.auth = new GoogleAuth(opts.credentialsPath)
    this.packageName = opts.packageName
    this.bucket = opts.reportBucket?.replace(/^gs:\/\//, '').replace(/\/.*$/, '')
  }

  private toRaw(r: PlayReview): RawReview | null {
    const user = r.comments?.find((c) => c.userComment)?.userComment
    if (!user) return null
    const dev = r.comments?.find((c) => c.developerComment)?.developerComment
    const at = secondsToDate(user.lastModified?.seconds)

    return {
      externalId: r.reviewId,
      rating: user.starRating ?? 0,
      body: user.text ?? '',
      language: user.reviewerLanguage ?? 'unknown',
      appVersion: user.appVersionName,
      device: user.device,
      authoredAt: at,
      updatedAt: at,
      existingReply: dev?.text
        ? { body: dev.text, repliedAt: secondsToDate(dev.lastModified?.seconds) }
        : undefined,
      raw: r,
    }
  }

  /** 최근 7일치 신규·수정 리뷰. cursor 는 페이지 토큰이다 */
  async fetchSince(cursor?: string): Promise<FetchResult> {
    const token = await this.auth.token([SCOPE_ANDROID_PUBLISHER])
    const reviews: RawReview[] = []
    let pageToken = cursor

    do {
      const url = new URL(`${API}/applications/${this.packageName}/reviews`)
      url.searchParams.set('maxResults', '100')
      if (pageToken) url.searchParams.set('token', pageToken)

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const body = (await res.json()) as {
        reviews?: PlayReview[]
        tokenPagination?: { nextPageToken?: string }
        error?: { message?: string }
      }
      if (!res.ok) throw new Error(`reviews.list ${res.status}: ${body.error?.message}`)

      for (const r of body.reviews ?? []) {
        const raw = this.toRaw(r)
        if (raw) reviews.push(raw)
      }
      pageToken = body.tokenPagination?.nextPageToken
    } while (pageToken)

    return { reviews, cursor: '' }
  }

  /**
   * 리포트 버킷에서 월별 CSV 를 읽어 과거 리뷰를 복원한다.
   * 7일 제약을 우회하는 유일한 경로다.
   */
  async bulkImport(range: { from: Date; to: Date }): Promise<RawReview[]> {
    if (!this.bucket) throw new Error('reportBucket 이 설정되지 않았다')
    const token = await this.auth.token([SCOPE_STORAGE_READ])

    const list = new URL(`${STORAGE}/b/${this.bucket}/o`)
    list.searchParams.set('prefix', 'reviews/')
    list.searchParams.set('maxResults', '1000')

    const res = await fetch(list, { headers: { Authorization: `Bearer ${token}` } })
    const body = (await res.json()) as { items?: { name: string }[]; error?: { message?: string } }
    if (!res.ok) {
      const msg = body.error?.message ?? ''
      if (res.status === 403) {
        throw new Error(`버킷 권한 없음. Play Console 권한 전파는 최대 24시간 걸린다 — ${msg}`)
      }
      if (res.status === 404) {
        throw new Error(`버킷을 찾을 수 없다. 콘솔에서 URI 를 다시 확인할 것 — ${msg}`)
      }
      throw new Error(`버킷 조회 ${res.status}: ${msg}`)
    }

    const months = new Set<string>()
    for (let d = new Date(range.from); d <= range.to; d.setMonth(d.getMonth() + 1)) {
      months.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
    }

    const targets = (body.items ?? []).filter((o) => {
      if (!o.name.includes(this.packageName)) return false
      const m = o.name.match(/_(\d{6})\.csv$/)?.[1]
      return m ? months.has(m) : false
    })

    const out: RawReview[] = []
    for (const obj of targets) {
      const dl = `${STORAGE}/b/${this.bucket}/o/${encodeURIComponent(obj.name)}?alt=media`
      const r = await fetch(dl, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(`CSV 다운로드 실패 ${obj.name}: ${r.status}`)
      out.push(...parseReviewsCsv(Buffer.from(await r.arrayBuffer())))
    }
    return out
  }

  async publishReply(externalId: string, replyText: string): Promise<void> {
    if (replyText.length > this.constraints.maxReplyLength) {
      throw new Error(`답변이 ${this.constraints.maxReplyLength}자를 넘는다: ${replyText.length}자`)
    }
    const token = await this.auth.token([SCOPE_ANDROID_PUBLISHER])
    const res = await fetch(
      `${API}/applications/${this.packageName}/reviews/${externalId}:reply`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyText }),
      },
    )
    if (!res.ok) {
      const b = (await res.json()) as { error?: { message?: string } }
      throw new Error(`답변 게시 실패 ${res.status}: ${b.error?.message}`)
    }
  }
}
