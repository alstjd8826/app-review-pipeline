/**
 * App Store Connect 연결 확인.
 * 설정은 워크시트에서 읽는다. 키를 바꾸면 워크시트만 고치면 된다.
 */
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { findSource, buildSource, type WorksheetWithSources } from '../sources/factory.js'

const line = () => console.log('─'.repeat(70))

async function main() {
  const WORKSHEET = worksheetPath()
  const w = loadWorksheet(WORKSHEET) as WorksheetWithSources
  const cfg = findSource(w, 'app-store')
  if (!cfg) {
    console.log('워크시트에 app-store 소스가 없다.')
    return
  }

  console.log(`앱 ID     : ${cfg.app_id}`)
  console.log(`Key ID    : ${cfg.key_id}`)
  console.log(`키 종류    : ${cfg.key_kind ?? 'individual'}`)
  console.log(`Issuer ID : ${cfg.issuer_id ?? '(개별 키라 불필요)'}`)
  line()

  const src = buildSource(cfg)
  if (!src) {
    console.log('✗ 설정이 불완전하다 (app_id / key_id / p8_path 확인)')
    process.exit(1)
  }

  const { reviews } = await src.fetchSince()
  console.log(`✓ 조회 성공 — ${reviews.length}건`)

  const stars: Record<number, number> = {}
  let replied = 0
  for (const r of reviews) {
    stars[r.rating] = (stars[r.rating] ?? 0) + 1
    if (r.existingReply) replied++
  }
  console.log(`  별점     : ${JSON.stringify(stars)}`)
  console.log(`  기존 답변 : ${replied}건`)
  line()

  for (const r of reviews.slice(0, 3)) {
    const d = r.authoredAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
    console.log(`  ★${r.rating} ${d}  ${r.title ?? ''}`)
    console.log(`     ${r.body.replace(/\s+/g, ' ').slice(0, 60)}`)
  }
}

main().catch((e) => {
  const msg = (e as Error).message
  console.error('✗', msg)
  if (msg.includes('401')) {
    console.error('\n401 이면 확인할 것')
    console.error('  - key_kind 가 실제 키 종류와 맞는가 (individual ↔ team)')
    console.error('  - 팀 키인데 issuer_id 가 빠지지 않았는가')
    console.error('  - .p8 경로가 맞는가')
  }
  process.exit(1)
})
