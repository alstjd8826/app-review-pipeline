/**
 * App Store Connect 소스 어댑터.
 * GUIDEBOOK.md 4.3
 *
 * Play 와 다른 점
 *   - 응답이 JSON:API 형식이다
 *   - links.next 커서 페이징
 *   - 조회 기간 제한이 없다 (Play 는 7일)
 *   - appVersion 필드가 없다
 */
import { AppleAuth, type AppleAuthOptions } from './apple-auth.js'
import type { FetchResult, RawReview, ReviewSource, SourceConstraints } from '../core/types.js'

const BASE = 'https://api.appstoreconnect.apple.com/v1'

interface AscReview {
  type: string
  id: string
  attributes: {
    rating: number
    title?: string
    body?: string
    reviewerNickname?: string
    createdDate: string
    territory?: string
  }
  relationships?: { response?: { data?: { id: string; type: string } | null } }
}

interface AscResponse {
  type: string
  id: string
  attributes: { responseBody: string; lastModifiedDate: string; state?: string }
}

interface AscPage {
  data?: AscReview[]
  included?: AscResponse[]
  links?: { next?: string }
  errors?: { title?: string; detail?: string; status?: string }[]
}

export interface AppStoreOptions extends AppleAuthOptions {
  appId: string
  /** 조회할 국가. 생략하면 전체 */
  territories?: string[]
}

export class AppStoreSource implements ReviewSource {
  readonly id = 'app-store'
  readonly constraints: SourceConstraints = {
    // 실제 상한은 Play 보다 훨씬 크다. 보수적으로 잡아둔다
    maxReplyLength: 5970,
    retentionDays: null,
    replyEditable: true,
  }

  private auth: AppleAuth
  private appId: string

  constructor(opts: AppStoreOptions) {
    this.auth = new AppleAuth(opts)
    this.appId = opts.appId
  }

  private async get(url: string): Promise<AscPage> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.auth.token()}` } })
    const body = (await res.json().catch(() => ({}))) as AscPage
    if (!res.ok) {
      const e = body.errors?.[0]
      const hint =
        res.status === 401
          ? ' — 401 이면 키 종류(개별/팀)와 payload(sub/iss), 서명 인코딩(ieee-p1363)을 확인할 것'
          : ''
      throw new Error(`ASC ${res.status}: ${e?.title ?? ''} ${e?.detail ?? ''}${hint}`)
    }
    return body
  }

  private toRaw(r: AscReview, responses: Map<string, AscResponse>): RawReview {
    const at = new Date(r.attributes.createdDate)
    const respId = r.relationships?.response?.data?.id
    const resp = respId ? responses.get(respId) : undefined

    return {
      externalId: r.id,
      rating: r.attributes.rating,
      title: r.attributes.title || undefined,
      body: r.attributes.body ?? '',
      // ASC 는 언어를 주지 않는다. 국가로 추정한다
      language: r.attributes.territory === 'KOR' ? 'ko' : 'unknown',
      country: r.attributes.territory,
      appVersion: undefined, // ⚠️ ASC 응답에 없는 필드다
      authoredAt: at,
      updatedAt: at,
      existingReply: resp
        ? { body: resp.attributes.responseBody, repliedAt: new Date(resp.attributes.lastModifiedDate) }
        : undefined,
      raw: r,
    }
  }

  async fetchSince(): Promise<FetchResult> {
    const first = new URL(`${BASE}/apps/${this.appId}/customerReviews`)
    first.searchParams.set('limit', '200')
    first.searchParams.set('sort', '-createdDate')
    // 기존 답변 본문을 같이 받는다. 없으면 별도 조회를 해야 한다
    first.searchParams.set('include', 'response')

    const reviews: RawReview[] = []
    let url: string | undefined = first.toString()

    while (url) {
      const page: AscPage = await this.get(url)
      const responses = new Map((page.included ?? []).map((r) => [r.id, r]))
      for (const r of page.data ?? []) reviews.push(this.toRaw(r, responses))
      url = page.links?.next
    }

    return { reviews, cursor: '' }
  }

  async publishReply(externalId: string, responseBody: string): Promise<void> {
    if (responseBody.length > this.constraints.maxReplyLength) {
      throw new Error(`답변이 ${this.constraints.maxReplyLength}자를 넘는다: ${responseBody.length}자`)
    }
    const res = await fetch(`${BASE}/customerReviewResponses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          type: 'customerReviewResponses',
          attributes: { responseBody },
          relationships: {
            review: { data: { type: 'customerReviews', id: externalId } },
          },
        },
      }),
    })
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as AscPage
      throw new Error(`답변 게시 실패 ${res.status}: ${b.errors?.[0]?.detail ?? ''}`)
    }
  }
}
