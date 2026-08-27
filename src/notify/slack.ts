/**
 * 슬랙 알림. 검수 화면 대신 쓴다.
 *
 * 메시지: 리뷰 원문
 * 스레드: 분류 · 초안 · 가드레일 · 답변 등록 링크
 *
 * 버튼을 쓰지 않으므로 Incoming Webhook 하나면 된다.
 * 사람이 실제로 등록한 답변은 다음 수집 때 existingReply 로 되읽어 초안과 비교한다.
 */
import { readFileSync } from 'node:fs'
import type { CaseRow } from '../storage/db.js'
import type { Review } from '../core/types.js'
import { categoryLabel, tagLabel, type Worksheet } from '../core/config.js'

const STAR = (n: number) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n))

const SOURCE_LABEL: Record<string, string> = {
  'google-play': 'Google Play',
  'app-store': 'App Store',
}

/** 콘솔 링크를 만드는 데 필요한 식별자. 전부 워크시트에서 온다 — 하드코딩하지 않는다 */
export interface ConsoleIds {
  appStoreId?: string
  /** Play Console URL 의 숫자 ID 두 개. 리포트 CSV 의 Review Link 에서 확인한다 */
  playDeveloperId?: string
  playAppId?: string
}

/**
 * 리뷰를 등록하러 갈 콘솔 링크.
 *
 * ⚠️ **Play 는 API 가 링크를 주지 않는다.** Review 리소스 필드는
 * `reviewId` · `authorName` · `comments[]` 세 개가 전부다.
 * 그래서 두 경로로 나뉜다.
 *
 *   리포트 CSV 로 들어온 과거 리뷰  → CSV 의 Review Link 를 그대로 쓴다
 *   API 로 들어온 신규 리뷰         → reviewId 로 URL 을 조립한다
 *
 * ⚠️ 조립하는 URL 형식은 구글이 문서화한 것이 아니다. 리포트 CSV 가 담고 있는
 * 형식을 그대로 따른 것이라 콘솔이 개편되면 깨질 수 있다. 그래서 식별자를
 * 워크시트에 두고, 없으면 버튼을 아예 붙이지 않는다 — 깨진 링크보다 없는 편이 낫다.
 */
export function consoleLink(review: Review, ids: ConsoleIds = {}): string | null {
  if (review.source === 'google-play') {
    const raw = review.raw as Record<string, unknown> | undefined

    // 리포트 CSV 로 들어온 건 구글이 직접 넣어준 링크가 있다. 그것을 우선한다.
    // CSV 는 http:// 로 준다 — 슬랙이 안전하지 않은 링크로 취급하므로 올려준다
    const fromCsv = raw?.['Review Link']
    if (typeof fromCsv === 'string' && fromCsv) return fromCsv.replace(/^http:\/\//, 'https://')

    // API 로 들어온 건 직접 만든다
    const reviewId = typeof raw?.reviewId === 'string' ? raw.reviewId : review.id
    if (!reviewId || !ids.playDeveloperId || !ids.playAppId) return null
    return (
      `https://play.google.com/console/developers/${ids.playDeveloperId}` +
      `/app/${ids.playAppId}/user-feedback/review-details` +
      `?reviewId=${encodeURIComponent(reviewId)}&corpus=PUBLIC_REVIEWS`
    )
  }
  if (review.source === 'app-store') {
    // ASC 는 리뷰별 앵커가 없다. 앱 리뷰 목록으로 보낸다
    if (!ids.appStoreId) return null
    return `https://appstoreconnect.apple.com/apps/${ids.appStoreId}/distribution/reviews`
  }
  return null
}

/** 워크시트에서 식별자를 모은다 */
export function consoleIds(w: {
  sources?: { id: string; app_id?: string | number; console_developer_id?: string | number; console_app_id?: string | number }[]
}): ConsoleIds {
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))
  const asc = w.sources?.find((s) => s.id === 'app-store')
  const play = w.sources?.find((s) => s.id === 'google-play')
  return {
    appStoreId: str(asc?.app_id),
    playDeveloperId: str(play?.console_developer_id),
    playAppId: str(play?.console_app_id),
  }
}

/** 2026-08-05 (KST) */
function fmtDate(d: Date) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
}

/**
 * 채널에 뜨는 본문 — 리뷰 그 자체
 *
 * 기기는 원인 파악이 필요한 카테고리에서만 보여준다.
 * API 가 주는 값이 마케팅명이 아니라 코드명이라(gta4xlwifi = Galaxy Tab S6 Lite)
 * 대부분의 리뷰에서는 읽을 수 없는 노이즈다.
 */
export function buildMainBlocks(review: Review, showDevice = false) {
  const meta = [
    SOURCE_LABEL[review.source] ?? review.source,
    fmtDate(review.authoredAt),
    review.appVersion ? `v${review.appVersion}` : null,
    showDevice ? review.device : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${STAR(review.rating)}*  ${review.title ? `*${review.title}*\n` : ''}${review.body}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: meta }],
    },
  ]
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: '긍정',
  neutral: '중립',
  negative: '부정',
}
const URGENCY_LABEL: Record<string, string> = {
  low: '낮음',
  normal: '보통',
  high: '높음',
}

/** 스레드에 붙는 검수 내용 */
export function buildThreadBlocks(c: CaseRow, limit: number, w?: Worksheet, ids: ConsoleIds = {}) {
  const cls = c.classification
  const blocks: unknown[] = []

  if (cls) {
    const cat = w ? categoryLabel(w, cls.category) : cls.category
    const tags = cls.tags.map((t) => (w ? tagLabel(w, t) : t))
    const conf = cls.confidence.toFixed(2)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${cat}*${tags.length ? `  ${tags.map((t) => `\`${t}\``).join(' ')}` : ''}\n` +
          `${SENTIMENT_LABEL[cls.sentiment] ?? cls.sentiment} · 긴급도 ${URGENCY_LABEL[cls.urgency] ?? cls.urgency} · 신뢰도 ${conf}\n` +
          `>${cls.evidence}`,
      },
    })
  }

  if (c.blocks.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⛔ 확인 필요*\n${c.blocks.map((b) => `• ${b.detail}`).join('\n')}`,
      },
    })
  }

  if (!c.draft) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*초안 없음* — 직접 작성해야 하는 리뷰입니다.' },
    })
    const link = consoleLink(c.review, ids)
    if (link) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '답변 등록하러 가기' },
            url: link,
            style: 'primary',
          },
        ],
      })
    }
  }

  return blocks
}

/**
 * 초안만 담는 메시지.
 *
 * 코드블록으로 감싸 본문과 시각적으로 구분한다.
 * 분류 결과와 다른 메시지로 나누면 초안만 따로 다루기 쉽다.
 */
export function buildDraftBlocks(c: CaseRow, limit: number, ids: ConsoleIds = {}) {
  if (!c.draft) return null
  const over = c.draft.charCount > limit
  const link = consoleLink(c.review, ids)

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*초안* (${c.draft.charCount}/${limit}자${over ? ' ⚠️ 초과' : ''})\n\`\`\`${c.draft.body}\`\`\``,
      },
    },
  ]

  if (link) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '답변 등록하러 가기' },
          url: link,
          style: 'primary',
        },
      ],
    })
  }

  return blocks
}

interface SlackApiResponse {
  ok: boolean
  ts?: string
  /** 응답에 채널 ID 가 담겨 온다. chat.delete 가 이름이 아닌 ID 를 요구하므로 저장해둔다 */
  channel?: string
  error?: string
}

const ERROR_HINT: Record<string, string> = {
  not_in_channel: '봇이 채널에 없다. 채널에서 /invite @앱이름 을 실행할 것',
  channel_not_found: '채널을 찾을 수 없다. 이름이 맞는지, 비공개 채널이면 봇을 초대했는지 확인',
  missing_scope: 'chat:write 스코프가 없다. OAuth & Permissions 에서 추가 후 재설치',
  invalid_auth: '토큰이 유효하지 않다',
}

/**
 * 봇 토큰으로 보낸다. Incoming Webhook 은 ts 를 돌려주지 않아 스레드를 못 단다.
 * chat.postMessage 는 ts 를 주므로 그걸 thread_ts 로 넘겨 코멘트를 붙인다.
 */
export class SlackNotifier {
  private token: string
  private channel: string

  constructor(channel: string, tokenPath = 'secrets/slack-bot-token.txt') {
    this.token = tokenPath.startsWith('xoxb-')
      ? tokenPath
      : readFileSync(tokenPath, 'utf8').trim()
    this.channel = channel
  }

  private async post(payload: Record<string, unknown>): Promise<{ ts: string; channel: string }> {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: this.channel, ...payload }),
    })
    const body = (await res.json()) as SlackApiResponse
    if (!body.ok) {
      const hint = body.error ? ERROR_HINT[body.error] : undefined
      throw new Error(`슬랙 전송 실패: ${body.error}${hint ? ` — ${hint}` : ''}`)
    }
    return { ts: body.ts!, channel: body.channel ?? this.channel }
  }

  /** 리뷰를 채널에 올리고, 검수 내용을 그 스레드에 붙인다 */
  async notify(
    c: CaseRow,
    limit: number,
    w?: Worksheet,
    ids: ConsoleIds = {},
  ): Promise<{ ts: string; channel: string }> {
    const showDevice = Boolean(
      c.classification &&
        w?.review_ui?.show_device_for?.includes(c.classification.category) &&
        c.review.device,
    )

    const parent = await this.post({
      text: `${STAR(c.review.rating)} ${c.review.body.slice(0, 60)}`, // 알림 미리보기
      blocks: buildMainBlocks(c.review, showDevice),
    })

    await this.post({
      thread_ts: parent.ts,
      text: c.draft ? '분류 결과' : '직접 작성 필요',
      blocks: buildThreadBlocks(c, limit, w, ids),
    })

    // 초안은 별도 메시지로. 복사하기 좋으라고 분리한다
    const draftBlocks = buildDraftBlocks(c, limit, ids)
    if (draftBlocks) {
      await this.post({
        thread_ts: parent.ts,
        text: c.draft!.body,
        blocks: draftBlocks,
      })
    }

    return parent
  }
}
