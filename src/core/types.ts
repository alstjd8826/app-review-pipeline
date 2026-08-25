/**
 * 파이프라인 공통 타입.
 * GUIDEBOOK.md 3장에 대응한다. 서비스가 바뀌어도 이 파일은 그대로다.
 */

/** 소스에서 막 꺼낸 상태. 아직 정규화 전 */
export interface RawReview {
  externalId: string
  rating: number
  title?: string
  body: string
  language: string
  country?: string
  appVersion?: string
  device?: string
  authoredAt: Date
  updatedAt: Date
  existingReply?: { body: string; repliedAt: Date }
  raw: unknown
}

/** 정규화된 리뷰. 뒤쪽 단계는 소스를 몰라도 된다 */
export interface Review extends RawReview {
  id: string
  source: string
  collectedAt: Date
}

export type Sentiment = 'positive' | 'neutral' | 'negative'
export type Urgency = 'low' | 'normal' | 'high'

export interface Classification {
  reviewId: string
  category: string
  tags: string[]
  sentiment: Sentiment
  urgency: Urgency
  /** 0~1. 낮으면 가드레일 ③에서 보류된다 */
  confidence: number
  /** 판단 근거가 된 원문 구절. 검수 화면에서 하이라이트한다 */
  evidence: string
  model: string
  classifiedAt: Date
}

export interface Draft {
  reviewId: string
  body: string
  language: string
  charCount: number
  model: string
  generatedAt: Date
}

export type GuardrailStage = 'input' | 'output' | 'confidence'

export interface GuardrailBlock {
  stage: GuardrailStage
  /** 어떤 규칙에 걸렸는지 */
  rule: string
  /** 걸린 값. 검수자에게 사람 말로 보여준다 */
  detail: string
  blockedAt: Date
}

export type CaseStatus =
  | 'COLLECTED'
  | 'CLASSIFIED'
  | 'DRAFTED'
  | 'BLOCKED'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'PUBLISH_FAILED'

export interface ReviewCase {
  reviewId: string
  status: CaseStatus
  classification?: Classification
  draft?: Draft
  blocks: GuardrailBlock[]
  finalBody?: string
  /** 초안에서 사람이 고쳤는지. 초안 채택률의 분모가 된다 */
  editedByHuman: boolean
  reviewerNote?: string
  decidedAt?: Date
  publishedAt?: Date
}

/** 플랫폼 제약. 가드레일이 이걸 읽어 쓴다 */
export interface SourceConstraints {
  maxReplyLength: number
  /** 조회 가능 기간(일). 무제한이면 null */
  retentionDays: number | null
  replyEditable: boolean
}

export interface FetchResult {
  reviews: RawReview[]
  cursor: string
}

/**
 * 새 플랫폼은 이 인터페이스 구현체 하나만 추가하면 된다.
 * GUIDEBOOK.md 4.1
 */
export interface ReviewSource {
  readonly id: string
  readonly constraints: SourceConstraints

  /** 신규·수정된 리뷰 */
  fetchSince(cursor?: string): Promise<FetchResult>

  /** 과거 데이터 벌크 임포트. 미지원이면 undefined */
  bulkImport?(range: { from: Date; to: Date }): Promise<RawReview[]>

  /** 답변 게시 */
  publishReply(externalId: string, body: string): Promise<void>
}
