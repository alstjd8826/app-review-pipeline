/**
 * 자격증명·연결 확인.
 * 워크시트에 정의된 모든 소스를 순서대로 점검한다.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { buildAllSources, findSource, type WorksheetWithSources } from '../sources/factory.js'
import { parseReviewsCsv } from '../sources/play-csv.js'
import { ClaudeCliClient } from '../core/llm.js'

const line = () => console.log('─'.repeat(70))

async function main() {
  const WORKSHEET = worksheetPath()
  let failed = false   // 없으면 파이프라인이 못 도는 것
  let warned = false   // 기능이 제한되지만 돌기는 하는 것
  const w = loadWorksheet(WORKSHEET) as WorksheetWithSources
  console.log(`워크시트: ${WORKSHEET}  ·  서비스: ${w.service.name}\n`)

  // ── 소스별 조회
  for (const { cfg, source } of buildAllSources(w)) {
    console.log(`[${cfg.id}]`)
    line()
    const detail =
      cfg.id === 'app-store'
        ? `앱 ${cfg.app_id} · ${cfg.key_kind ?? 'individual'} 키 ${cfg.key_id}`
        : `${cfg.package_name}`
    console.log(`  ${detail}`)
    try {
      const { reviews } = await source.fetchSince()
      const window = source.constraints.retentionDays
      console.log(`  ✓ 조회 성공 — ${reviews.length}건${window ? ` (최근 ${window}일)` : ''}`)
      if (!reviews.length && window) {
        console.log(`    (${window}일 내 텍스트 리뷰 없음. 정상이다)`)
      }
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message.slice(0, 120)}`)
      failed = true
    }
    console.log()
  }

  // ── Play 리포트 버킷
  const playEntry = buildAllSources(w).find((s) => s.cfg.id === 'google-play')
  if (playEntry?.source.bulkImport) {
    console.log('[google-play 리포트 버킷]')
    line()
    try {
      const reviews = await playEntry.source.bulkImport({
        from: new Date('2024-01-01'),
        to: new Date(),
      })
      console.log(`  ✓ 임포트 성공 — ${reviews.length}건`)
    } catch (e) {
      // 버킷은 과거 데이터 백필 전용이다. 없어도 일상 운영은 돈다.
      // 실패로 취급하면 권한 대기 중에 워크플로가 매번 죽는다
      console.log(`  △ ${(e as Error).message.slice(0, 100)}`)
      console.log('    (백필 전용이라 치명적이지 않다. 로컬 CSV 로 대체 가능)')
      warned = true
    }
    console.log()
  }

  // ── 로컬 CSV (버킷 대체 경로)
  if (existsSync('data')) {
    const files = readdirSync('data').filter((f) => f.endsWith('.csv'))
    if (files.length) {
      console.log('[로컬 CSV]')
      line()
      let total = 0
      for (const f of files) {
        const n = parseReviewsCsv(readFileSync(join('data', f))).length
        total += n
        console.log(`  ${f.replace(/^.*_(\d{6})\.csv$/, '$1')}  ${n}건`)
      }
      console.log(`  합계 ${total}건`)
      console.log()
    }
  }

  // ── LLM
  // ⚠️ 새 리뷰가 없으면 파이프라인이 LLM 을 한 번도 안 부른다.
  //    토큰이 죽어 있어도 실행은 성공하므로 여기서 따로 확인한다
  console.log('[LLM]')
  line()
  const llm = new ClaudeCliClient('sonnet')
  console.log(`  ${llm.name}`)
  try {
    const t0 = Date.now()
    const answer = await llm.complete('다른 말 없이 정확히 "ok" 한 단어만 출력하라.')
    const ms = Date.now() - t0
    const got = answer.trim().toLowerCase().slice(0, 20)
    if (got.includes('ok')) {
      console.log(`  ✓ 응답 정상 (${(ms / 1000).toFixed(1)}초)`)
    } else {
      console.log(`  △ 응답은 왔으나 예상과 다름: ${got}`)
    }
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message.slice(0, 140)}`)
    console.log('    토큰이 만료됐을 수 있다 — OPERATIONS.md 2-1')
    failed = true
  }
  console.log()

  // ── 슬랙
  const channel = w.notify?.channel
  console.log('[슬랙]')
  line()
  console.log(`  채널: ${channel ?? '(미설정)'}`)
  console.log(`  토큰: ${existsSync('secrets/slack-bot-token.txt') ? '✓ 있음' : '✗ 없음'}`)

  console.log()
  if (failed) {
    console.log('✗ 파이프라인이 돌 수 없는 문제가 있다')
    process.exit(1)
  }
  console.log(warned ? '✓ 동작 가능 (일부 기능 제한)' : '✓ 전부 정상')
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
