/**
 * 분류 에이전트. GUIDEBOOK.md 6장
 * 프롬프트 구조는 고정, 서비스 고유값은 워크시트에서 온다.
 */
import type { LlmClient } from '../core/llm.js'
import { extractJson } from '../core/llm.js'
import { renderCategoryList, renderTagList, type Worksheet } from '../core/config.js'
import type { Classification, Review, Sentiment, Urgency } from '../core/types.js'

interface RawClassification {
  category: string
  tags?: string[]
  sentiment: Sentiment
  urgency: Urgency
  confidence: number
  evidence: string
}

export function buildClassifyPrompt(w: Worksheet, review: Review): string {
  return `당신은 ${w.service.name} 앱의 고객 리뷰를 분류하는 분석가다.
리뷰를 읽고 아래 스키마에 맞는 JSON만 출력한다. 다른 말은 쓰지 않는다.

## 카테고리 (하나만 고른다)
${renderCategoryList(w)}

## 태그 (해당하는 것 모두)
${renderTagList(w)}

## 서비스 맥락
${w.service.context.trim()}

## 판단 규칙
- category 는 반드시 위 목록에서 고른다. 애매하면 "${w.taxonomy.fallback}".
- evidence 에는 판단 근거가 된 원문 구절을 그대로 인용한다. 요약하지 않는다.
- confidence 는 스스로 얼마나 확신하는지다. 애매하면 낮게 준다.
  0.9 이상 = 명확함 / 0.7~0.9 = 대체로 확실 / 0.7 미만 = 애매함
- urgency:
    high   = 결제 사고, 안전, 법적 분쟁, 서비스 전면 장애
    normal = 기능 오류, 사용 불편
    low    = 칭찬, 단순 의견
- 리뷰가 여러 주제를 담으면 가장 강한 불만을 category 로 잡고 나머지는 tags 로 둔다.

## 출력 스키마
{
  "category": "<id>",
  "tags": ["<id>", ...],
  "sentiment": "positive" | "neutral" | "negative",
  "urgency": "low" | "normal" | "high",
  "confidence": 0.0~1.0,
  "evidence": "<원문 인용>"
}

## 입력
별점: ${review.rating}/5
앱 버전: ${review.appVersion ?? '알 수 없음'}
언어: ${review.language}
제목: ${review.title ?? '(없음)'}
리뷰: """
${review.body}
"""`
}

export async function classify(
  llm: LlmClient,
  w: Worksheet,
  review: Review,
): Promise<Classification> {
  const text = await llm.complete(buildClassifyPrompt(w, review))
  const parsed = extractJson<RawClassification>(text)

  const known = new Set(w.taxonomy.categories.map((c) => c.id))
  const category = known.has(parsed.category) ? parsed.category : w.taxonomy.fallback

  return {
    reviewId: review.id,
    category,
    tags: parsed.tags ?? [],
    sentiment: parsed.sentiment,
    urgency: parsed.urgency,
    confidence: parsed.confidence,
    evidence: parsed.evidence,
    model: llm.name,
    classifiedAt: new Date(),
  }
}
