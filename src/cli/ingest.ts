/**
 * 수집 → 저장. GUIDEBOOK.md 1단계
 *
 * 소스 설정은 워크시트에서 읽는다. CLI 는 자격증명을 알지 못한다.
 * 여러 번 돌려도 안전하다 — (source, external_id) 로 upsert 한다.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { buildAllSources, findSource, type WorksheetWithSources } from '../sources/factory.js'
import { parseReviewsCsv } from '../sources/play-csv.js'
import { Store } from '../storage/db.js'
import type { RawReview, Review } from '../core/types.js'

const line = () => console.log('─'.repeat(70))

const toReview = (r: RawReview, source: string): Review => ({
  ...r,
  id: `${source}:${r.externalId}`,
  source,
  collectedAt: new Date(),
})

async function main() {
  const WORKSHEET = worksheetPath()
  const w = loadWorksheet(WORKSHEET) as WorksheetWithSources
  const store = new Store()
  const collected: Review[] = []

  // ── 각 소스에서 신규·수정분
  for (const { cfg, source } of buildAllSources(w)) {
    try {
      const { reviews } = await source.fetchSince()
      collected.push(...reviews.map((r) => toReview(r, cfg.id)))
      const window = source.constraints.retentionDays
      console.log(`  ${cfg.id.padEnd(12)} ${reviews.length}건${window ? ` (최근 ${window}일)` : ''}`)
    } catch (e) {
      console.log(`  ${cfg.id.padEnd(12)} 실패 — ${(e as Error).message.slice(0, 60)}`)
    }
  }

  // ── Play 벌크 임포트 (7일 제약 우회)
  const playCfg = findSource(w, 'google-play')
  const play = playCfg ? buildAllSources(w).find((s) => s.cfg.id === 'google-play')?.source : null

  if (play?.bulkImport) {
    const from = playCfg?.backfill_from
      ? new Date(`${String(playCfg.backfill_from).slice(0, 4)}-${String(playCfg.backfill_from).slice(4, 6)}-01`)
      : new Date(Date.now() - 365 * 24 * 3600 * 1000)
    try {
      const bulk = await play.bulkImport({ from, to: new Date() })
      collected.push(...bulk.map((r) => toReview(r, 'google-play')))
      console.log(`  google-play  ${bulk.length}건 (리포트 버킷)`)
    } catch (e) {
      console.log(`  google-play  버킷 건너뜀 — ${(e as Error).message.slice(0, 50)}`)

      // 버킷 권한이 없으면 로컬에 받아둔 CSV 로 대체한다
      if (existsSync('data')) {
        let n = 0
        for (const f of readdirSync('data').filter((x) => x.endsWith('.csv'))) {
          for (const r of parseReviewsCsv(readFileSync(join('data', f)))) {
            collected.push(toReview(r, 'google-play'))
            n++
          }
        }
        if (n) console.log(`  google-play  ${n}건 (로컬 CSV 대체)`)
      }
    }
  }

  line()
  console.log(`저장 ${store.upsertReviews(collected)}건 (중복은 갱신)`)

  // 스토어에 답변이 달린 케이스를 정리한다.
  // 사람이 콘솔에서 직접 등록하므로 이게 유일한 "완료" 신호다
  const rec = store.reconcile()
  if (rec.published) {
    const parts = [
      rec.unchanged ? `초안 그대로 ${rec.unchanged}` : null,
      rec.edited ? `수정 ${rec.edited}` : null,
      rec.authored ? `직접 작성 ${rec.authored}` : null,
    ].filter(Boolean)
    console.log(`  대사 완료   ${rec.published}건 발행 확인 (${parts.join(' · ')})`)
  }

  console.log(`  미처리      ${store.pendingReviews().length}건`)
  console.log(`  검수 대기   ${store.openCases()}건`)
  console.log(`  기존 답변   ${store.answeredReviews().length}건 (few-shot 재료)`)

  store.close()
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
