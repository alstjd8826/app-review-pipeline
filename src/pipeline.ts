/**
 * 파이프라인 조립. GUIDEBOOK.md 3.4 상태 전이
 *
 *   COLLECTED → CLASSIFIED → DRAFTED  → PENDING_REVIEW
 *                        ↘ BLOCKED ↗
 */
import type { LlmClient } from './core/llm.js'
import type { Worksheet } from './core/config.js'
import type { Review, ReviewCase } from './core/types.js'
import { classify } from './agents/classify.js'
import { draft, type ReplyExample } from './agents/draft.js'
import {
  checkConfidence,
  checkInputGate,
  checkOutput,
  shouldSkipDraft,
} from './agents/guardrails.js'

export interface ProcessOptions {
  /** 이 길이로 쓰라는 목표. 플랫폼 상한이 아니다 (GUIDEBOOK 7.4) */
  targetLength: number
  /** 플랫폼 상한. 출력 검증이 이걸로 판정한다 */
  platformLimit: number
  examples: ReplyExample[]
}

export async function processReview(
  llm: LlmClient,
  w: Worksheet,
  review: Review,
  opts: ProcessOptions,
): Promise<ReviewCase> {
  const kase: ReviewCase = {
    reviewId: review.id,
    status: 'COLLECTED',
    blocks: [],
    editedByHuman: false,
  }

  // ── 분류
  const c = await classify(llm, w, review)
  kase.classification = c
  kase.status = 'CLASSIFIED'

  // ── 가드레일 ① 입력 게이트
  kase.blocks.push(...checkInputGate(w, review, c))

  // ── 가드레일 ③ 신뢰도
  kase.blocks.push(...checkConfidence(w, c))

  if (shouldSkipDraft(kase.blocks)) {
    // 초안 없이 검수 큐로. 사람이 직접 쓴다
    kase.status = 'BLOCKED'
    return kase
  }

  // ── 초안
  const d = await draft(llm, w, review, c, {
    maxLength: Math.min(opts.targetLength, opts.platformLimit),
    examples: opts.examples,
  })
  kase.draft = d
  kase.status = 'DRAFTED'

  // ── 가드레일 ② 출력 검증
  kase.blocks.push(...checkOutput(w, review, d, opts.platformLimit))

  kase.status = 'PENDING_REVIEW'
  return kase
}
