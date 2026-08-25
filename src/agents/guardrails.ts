/**
 * 가드레일 3단. GUIDEBOOK.md 8장
 *
 * 원칙 — 모든 차단의 결과는 "거부"가 아니라 "사람에게 넘김"이다.
 * 한 곳에서 다 막으면 어디서 걸렸는지 모르므로 성격이 다른 세 지점에 나눈다.
 */
import type { Worksheet } from '../core/config.js'
import type { Classification, Draft, GuardrailBlock, Review } from '../core/types.js'

const now = () => new Date()

/**
 * ① 입력 게이트 — 초안 생성 자체를 막는다.
 * 답변을 잘못 쓰면 위험한 리뷰는 AI 가 손대지 않는다.
 */
export function checkInputGate(
  w: Worksheet,
  review: Review,
  c: Classification,
): GuardrailBlock[] {
  const blocks: GuardrailBlock[] = []

  // 카테고리 차단
  const blocked = w.guardrails.block_categories ?? []
  if (blocked.includes(c.category)) {
    const label = w.taxonomy.categories.find((x) => x.id === c.category)?.label ?? c.category
    blocks.push({
      stage: 'input',
      rule: 'block_category',
      detail: `'${label}' 카테고리는 자동 초안을 만들지 않습니다. 직접 작성하거나 고객센터로 이관하세요.`,
      blockedAt: now(),
    })
  }

  // 위험 키워드 — 제목과 본문 모두 본다
  const haystack = `${review.title ?? ''} ${review.body}`
  for (const kw of w.guardrails.block_keywords ?? []) {
    if (haystack.includes(kw)) {
      blocks.push({
        stage: 'input',
        rule: 'block_keyword',
        detail: `리뷰에 '${kw}' 이(가) 포함되어 있습니다. 사람이 직접 판단해야 하는 사안입니다.`,
        blockedAt: now(),
      })
    }
  }

  return blocks
}

/**
 * ③ 신뢰도 임계 — 애매하면 멈춘다.
 * 초안은 만들되 자동 흐름에서 빼고 검수 대기로 보낸다.
 */
export function checkConfidence(w: Worksheet, c: Classification): GuardrailBlock[] {
  const min = w.guardrails.min_confidence ?? 0.75
  if (c.confidence >= min) return []
  return [
    {
      stage: 'confidence',
      rule: 'min_confidence',
      detail: `분류 신뢰도가 ${c.confidence.toFixed(2)} 로 기준(${min}) 미만입니다. 분류가 맞는지 확인해 주세요.`,
      blockedAt: now(),
    },
  ]
}

const HANGUL = /[가-힣]/

/**
 * ② 출력 검증 — 기계적으로 확인한다.
 * 프롬프트로 부탁한 것들이 실제로 지켜졌는지 여기서 판정한다.
 */
export function checkOutput(
  w: Worksheet,
  review: Review,
  d: Draft,
  maxLength: number,
): GuardrailBlock[] {
  const blocks: GuardrailBlock[] = []

  // 길이 — 프롬프트 지시는 자주 무시된다. 반드시 기계로 잰다
  if (d.charCount > maxLength) {
    blocks.push({
      stage: 'output',
      rule: 'max_length',
      detail: `답변이 ${d.charCount}자로 제한(${maxLength}자)을 ${d.charCount - maxLength}자 초과했습니다.`,
      blockedAt: now(),
    })
  }

  // 금칙어 — 지키지 못할 약속
  for (const phrase of w.guardrails.forbidden_phrases ?? []) {
    if (d.body.includes(phrase)) {
      blocks.push({
        stage: 'output',
        rule: 'forbidden_phrase',
        detail: `확정 약속 표현이 들어 있습니다: "${phrase}"`,
        blockedAt: now(),
      })
    }
  }

  // 언어 일치 — 한국어 리뷰에 한글이 없으면 이상하다
  if (review.language.startsWith('ko') && !HANGUL.test(d.body)) {
    blocks.push({
      stage: 'output',
      rule: 'language_mismatch',
      detail: '한국어 리뷰인데 답변에 한글이 없습니다.',
      blockedAt: now(),
    })
  }

  // 허용되지 않은 링크
  const allowed = (w.policy.allowed_links ?? []).filter((l) => l && l !== 'TODO')
  for (const url of d.body.match(/https?:\/\/[^\s)]+/g) ?? []) {
    if (!allowed.some((a) => url.startsWith(a))) {
      blocks.push({
        stage: 'output',
        rule: 'unallowed_link',
        detail: `허용 목록에 없는 링크가 있습니다: ${url}`,
        blockedAt: now(),
      })
    }
  }

  // 전화번호
  const phone = d.body.match(/\d{2,3}-\d{3,4}-\d{4}/)
  if (phone) {
    blocks.push({
      stage: 'output',
      rule: 'phone_number',
      detail: `연락처가 직접 노출됐습니다: ${phone[0]}`,
      blockedAt: now(),
    })
  }

  // 사과 남발
  const apologies = (d.body.match(/죄송|사과드/g) ?? []).length
  if (apologies > 1) {
    blocks.push({
      stage: 'output',
      rule: 'excessive_apology',
      detail: `사과 표현이 ${apologies}번 나옵니다. 1회로 줄여 주세요.`,
      blockedAt: now(),
    })
  }

  // 서명 누락 — 정책에 맺음 문구가 있으면 확인한다
  if (w.policy.signature && !d.body.includes(w.policy.signature)) {
    blocks.push({
      stage: 'output',
      rule: 'missing_signature',
      detail: `맺음 문구가 없습니다: "${w.policy.signature}"`,
      blockedAt: now(),
    })
  }

  return blocks
}

/** 입력 게이트에 걸리면 초안을 만들지 않는다 */
export function shouldSkipDraft(blocks: GuardrailBlock[]): boolean {
  return blocks.some((b) => b.stage === 'input')
}
