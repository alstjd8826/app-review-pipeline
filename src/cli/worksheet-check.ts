/**
 * 워크시트가 올바른지 확인한다.
 *
 *   npm run worksheet:check                    # 기본 워크시트
 *   npm run worksheet:check -- <경로>          # 특정 파일
 *
 * 새 서비스에 적용할 때 워크시트를 다 채웠는지 검사하는 용도다.
 */
import { loadWorksheet, worksheetPath, type Worksheet } from '../core/config.js'
import type { WorksheetWithSources } from '../sources/factory.js'

const path = process.argv[2] ?? worksheetPath()

interface Issue {
  level: 'error' | 'warn'
  msg: string
}

function check(w: WorksheetWithSources): Issue[] {
  const out: Issue[] = []
  const err = (m: string) => out.push({ level: 'error', msg: m })
  const warn = (m: string) => out.push({ level: 'warn', msg: m })

  if (!w.service?.name) err('service.name 이 비어 있다')
  if (!w.service?.context?.trim()) warn('service.context 가 비어 있다 — 분류 품질에 영향을 준다')

  const sources = w.sources ?? []
  if (!sources.length) err('sources 가 비어 있다')
  for (const s of sources) {
    if (s.id === 'google-play') {
      if (!s.package_name) err('google-play: package_name 없음')
      // 없으면 신규 리뷰 카드에 '답변 등록하러 가기' 버튼이 조용히 빠진다.
      // API 가 리뷰 링크를 주지 않아 이 값으로 조립하기 때문이다
      if (!s.console_developer_id || !s.console_app_id) {
        warn(
          'google-play: console_developer_id / console_app_id 가 없다 — ' +
            '신규 리뷰에 답변 등록 링크가 붙지 않는다 (API 는 링크를 주지 않는다)',
        )
      }
    }
    if (s.id === 'app-store') {
      if (!s.app_id) err('app-store: app_id 없음')
      if (s.key_kind === 'team' && !s.issuer_id) {
        err('app-store: 팀 키에는 issuer_id 가 필요하다 (개별 키는 sub, 팀 키는 iss)')
      }
      if (s.key_kind === 'individual' && s.issuer_id) {
        warn('app-store: 개별 키는 issuer_id 를 쓰지 않는다')
      }
    }
  }

  const cats = w.taxonomy?.categories ?? []
  if (cats.length < 2) err('taxonomy.categories 가 너무 적다')
  if (cats.length > 12) warn(`카테고리 ${cats.length}개 — 많을수록 분류 정확도가 떨어진다`)
  if (!w.taxonomy?.fallback) err('taxonomy.fallback 이 없다 — "기타" 카테고리는 반드시 둔다')
  else if (!cats.some((c) => c.id === w.taxonomy.fallback)) {
    err(`taxonomy.fallback "${w.taxonomy.fallback}" 이 categories 에 없다`)
  }

  const ids = cats.map((c) => c.id)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dup.length) err(`카테고리 id 중복: ${[...new Set(dup)].join(', ')}`)

  // 가드레일이 없는 카테고리를 가리키면 조용히 무효가 된다
  for (const b of w.guardrails?.block_categories ?? []) {
    if (!ids.includes(b)) err(`guardrails.block_categories 의 "${b}" 가 categories 에 없다`)
  }

  const p = w.policy ?? {}
  if (!p.signature) warn('policy.signature 가 없다 — 가드레일의 서명 검사가 동작하지 않는다')
  if (!(p.cannot_promise ?? []).length) warn('policy.cannot_promise 가 비어 있다')
  const links = (p.allowed_links ?? []).filter((l) => l && l !== 'TODO')
  if (!links.length) warn('policy.allowed_links 가 비어 있다 — 답변에 어떤 링크도 넣을 수 없다')

  const target = (p as { target_reply_length?: number }).target_reply_length
  const limit = w.guardrails?.max_reply_length
  if (target && limit && target > limit) {
    err(`target_reply_length(${target}) 가 max_reply_length(${limit}) 보다 크다`)
  }

  if (!w.notify?.channel) err('notify.channel 이 없다')
  if (!w.notify?.skip_before) {
    warn('notify.skip_before 가 없다 — 첫 실행에 과거 리뷰가 한꺼번에 전송된다')
  }

  // 태그 라벨 누락은 화면에 영문 id 가 그대로 나온다
  const allTags = cats.flatMap((c) => c.tags ?? [])
  const missing = allTags.filter((t) => !w.tag_labels?.[t])
  if (missing.length) warn(`tag_labels 누락 ${missing.length}개: ${missing.slice(0, 5).join(', ')}`)

  return out
}

const w = loadWorksheet(path) as WorksheetWithSources & Worksheet
console.log(`워크시트: ${path}`)
console.log(`서비스  : ${w.service?.name || '(미설정)'}`)
console.log('─'.repeat(66))

const issues = check(w)
const errors = issues.filter((i) => i.level === 'error')

for (const i of issues) console.log(`  ${i.level === 'error' ? '✗' : '△'} ${i.msg}`)

console.log('─'.repeat(66))
if (!issues.length) console.log('✓ 문제 없음')
else console.log(`오류 ${errors.length} · 경고 ${issues.length - errors.length}`)

if (errors.length) process.exit(1)
