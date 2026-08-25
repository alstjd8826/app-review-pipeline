/**
 * 워크시트 로더. GUIDEBOOK.md 12장
 * 서비스 고유값은 전부 여기서 온다. 코드에 하드코딩하지 않는다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { parse } from 'yaml'

/**
 * 사용할 워크시트 경로.
 *
 *   1. WORKSHEET 환경변수
 *   2. worksheet.yaml
 *   3. worksheet.<무엇>.yaml 중 첫 번째 (예: worksheet.myapp.yaml)
 *
 * 서비스 이름을 코드에 박지 않기 위한 규칙이다.
 */
export function worksheetPath(): string {
  const fromEnv = process.env.WORKSHEET
  if (fromEnv) return fromEnv
  if (existsSync('worksheet.yaml')) return 'worksheet.yaml'

  const found = readdirSync('.')
    .filter((f) => /^worksheet\..+\.ya?ml$/.test(f) && !f.includes('example'))
    .sort()
  if (found[0]) return found[0]

  throw new Error(
    '워크시트를 찾을 수 없다. worksheet.yaml 을 만들거나 WORKSHEET 환경변수를 지정할 것 ' +
      '(worksheet.example.yaml 참고)',
  )
}

export interface CategoryDef {
  id: string
  label: string
  description?: string
  tags?: string[]
  auto_draft?: boolean
}

export interface Policy {
  speaker?: string
  address_reader?: string
  greeting?: string
  signature?: string
  formality?: string
  emoji?: string
  apology_scope?: string
  observed_patterns?: string[]
  cannot_promise?: string[]
  allowed_links?: string[]
  do_not_reply?: string[]
}

export interface Worksheet {
  service: {
    name: string
    type: string
    context: string
    languages: string[]
  }
  taxonomy: {
    categories: CategoryDef[]
    fallback: string
  }
  policy: Policy
  category_guidance?: Record<string, string>
  /** 태그 id → 사람이 읽는 라벨 */
  tag_labels?: Record<string, string>
  notify?: {
    channel?: string
    /** 이 날짜(YYYY-MM-DD)보다 오래된 리뷰는 전송하지 않는다 */
    skip_before?: string
  }
  review_ui?: {
    form?: string
    reviewer?: string
    /** 기기 정보를 보여줄 카테고리 */
    show_device_for?: string[]
  }
  guardrails: {
    block_categories?: string[]
    block_keywords?: string[]
    forbidden_phrases?: string[]
    max_reply_length?: number
    min_confidence?: number
  }
}

export function loadWorksheet(path: string): Worksheet {
  return parse(readFileSync(path, 'utf8')) as Worksheet
}

/** 프롬프트에 넣을 카테고리 목록 문자열 */
export function renderCategoryList(w: Worksheet): string {
  return w.taxonomy.categories
    .map((c) => `- ${c.id} — ${c.label}${c.description ? `: ${c.description}` : ''}`)
    .join('\n')
}

/** 프롬프트에 넣을 태그 목록 문자열 */
export function renderTagList(w: Worksheet): string {
  return w.taxonomy.categories
    .filter((c) => c.tags?.length)
    .map((c) => `- ${c.id}: ${c.tags!.join(', ')}`)
    .join('\n')
}

/** 알림 채널. 워크시트에 없으면 실패시킨다 — 코드에 기본값을 두지 않는다 */
export function requireChannel(w: Worksheet): string {
  const c = w.notify?.channel
  if (!c) throw new Error('워크시트에 notify.channel 이 없다')
  return c
}

/** 카테고리 id → 사람이 읽는 라벨 */
export function categoryLabel(w: Worksheet, id: string): string {
  return w.taxonomy.categories.find((c) => c.id === id)?.label ?? id
}

/** 태그 id → 사람이 읽는 라벨. 없으면 id 그대로 */
export function tagLabel(w: Worksheet, id: string): string {
  return w.tag_labels?.[id] ?? id
}
