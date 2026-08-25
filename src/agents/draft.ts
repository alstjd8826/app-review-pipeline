/**
 * 초안 에이전트. GUIDEBOOK.md 7장
 *
 * 핵심 두 가지
 *   - 분류 결과를 함께 넣는다. 원문만 주면 매번 다르게 해석한다 (7.1)
 *   - few-shot 예시를 대상 플랫폼 길이로 걸러 넣는다 (7.4)
 */
import type { LlmClient } from '../core/llm.js'
import type { Policy, Worksheet } from '../core/config.js'
import type { Classification, Draft, Review } from '../core/types.js'

export interface ReplyExample {
  reviewBody: string
  replyBody: string
}

export interface DraftOptions {
  maxLength: number
  /** 기존 답변 풀. 길이로 걸러서 쓴다 */
  examples: ReplyExample[]
  maxExamples?: number
}

function renderPolicy(p: Policy): string {
  const lines = [
    `- 화자: ${p.speaker ?? '브랜드 공식'}`,
    `- 독자 호칭: ${p.address_reader ?? '고객님'}`,
    `- 말투: ${p.formality ?? '정중한 존댓말'}`,
  ]
  if (p.greeting) lines.push(`- 첫 문장은 이렇게 시작한다: "${p.greeting}"`)
  if (p.signature) lines.push(`- 마지막은 반드시 이 문구로 닫는다: "${p.signature}"`)
  if (p.emoji) lines.push(`- 이모지: ${p.emoji}`)
  if (p.apology_scope) lines.push(`- 사과 범위: ${p.apology_scope}`)
  return lines.join('\n')
}

/**
 * ⚠️ 대상 플랫폼 제한을 넘는 예시는 넣지 않는다.
 *    긴 예시를 주면 모델이 그 길이를 따라 쓰고 가드레일 ② 에 걸린다.
 */
export function selectExamples(
  examples: ReplyExample[],
  maxLength: number,
  count: number,
): ReplyExample[] {
  return examples
    .filter((e) => e.replyBody.length <= maxLength)
    .sort((a, b) => b.replyBody.length - a.replyBody.length) // 제한에 가까운 것부터
    .slice(0, count)
}

export function buildDraftPrompt(
  w: Worksheet,
  review: Review,
  c: Classification,
  opts: DraftOptions,
): string {
  const picked = selectExamples(opts.examples, opts.maxLength, opts.maxExamples ?? 3)
  const guidance = w.category_guidance?.[c.category] ?? '리뷰 내용에 맞게 정중히 답한다.'
  const cannot = (w.policy.cannot_promise ?? []).join(', ') || '없음'
  const links = (w.policy.allowed_links ?? []).filter((l) => l && l !== 'TODO')

  const exampleBlock = picked.length
    ? picked
        .map(
          (e, i) =>
            `### 예시 ${i + 1} (${e.replyBody.length}자)\n리뷰: ${e.reviewBody.replace(/\s+/g, ' ').slice(0, 120)}\n답변: ${e.replyBody}`,
        )
        .join('\n\n')
    : '(없음)'

  return `당신은 ${w.service.name}의 공식 답변 담당자다.
아래 고객 리뷰에 대한 답변을 쓴다. 답변 본문만 출력한다. 설명이나 머리말을 붙이지 않는다.

## 화자와 톤
${renderPolicy(w.policy)}

## 반드시 지킬 것
- ${review.language === 'ko' ? '한국어' : review.language} 로 쓴다. 리뷰와 같은 언어다.
- **${opts.maxLength}자를 넘지 않는다.** 공백 포함이며 이 제한은 절대적이다.
  긴 답변을 쓴 뒤 줄이지 말고, 처음부터 이 길이에 맞춰 쓴다.
- 확인할 수 없는 사실을 단정하지 않는다.
- 다음은 절대 확정하지 않는다: ${cannot}
- 고객이 쓴 표현을 한 번은 받아 적어 읽었다는 신호를 준다.

## 하지 말 것
- 사과를 두 번 이상 하기
- 구체적 일정이나 버전을 약속하기
- 링크나 연락처를 임의로 만들어 쓰기${links.length ? ` (허용: ${links.join(', ')})` : ''}
- 템플릿처럼 읽히는 상투구로만 채우기

## 이 리뷰의 분류
카테고리: ${c.category}
태그: ${c.tags.join(', ') || '-'}
감정: ${c.sentiment}
근거가 된 구절: ${c.evidence}

## 카테고리 지침
${guidance.trim()}

## 좋은 답변 예시
아래는 실제로 발행된 답변이다. 말투와 구조를 따른다.

${exampleBlock}

## 입력
별점: ${review.rating}/5
제목: ${review.title ?? '(없음)'}
리뷰: """
${review.body}
"""`
}

export async function draft(
  llm: LlmClient,
  w: Worksheet,
  review: Review,
  c: Classification,
  opts: DraftOptions,
): Promise<Draft> {
  const body = (await llm.complete(buildDraftPrompt(w, review, c, opts)))
    .trim()
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .trim()

  return {
    reviewId: review.id,
    body,
    language: review.language,
    charCount: body.length,
    model: llm.name,
    generatedAt: new Date(),
  }
}
