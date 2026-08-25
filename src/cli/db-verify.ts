/**
 * 원격 DB 왕복 검증.
 * 로컬 DB 를 건드리지 않고 별도 경로로 받아 내용을 대조한다.
 */
import Database from 'better-sqlite3'
import { existsSync, unlinkSync, statSync } from 'node:fs'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { pullDb, remoteConfig } from '../storage/remote.js'

const TMP = 'data/_pulled.db'

const counts = (path: string) => {
  const db = new Database(path, { readonly: true })
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  const r = {
    리뷰: q('SELECT COUNT(*) n FROM review'),
    케이스: q('SELECT COUNT(*) n FROM review_case'),
    가드레일: q('SELECT COUNT(*) n FROM guardrail_block'),
    기존답변: q('SELECT COUNT(*) n FROM review WHERE reply_body IS NOT NULL'),
    알림완료: q('SELECT COUNT(*) n FROM review_case WHERE notified_at IS NOT NULL'),
  }
  db.close()
  return r
}

async function main() {
  const WORKSHEET = worksheetPath()
  const w = loadWorksheet(WORKSHEET) as Parameters<typeof remoteConfig>[0]
  const cfg = remoteConfig(w)
  if (!cfg) {
    console.log('원격 저장소 미설정')
    return
  }

  console.log(`원격: ${cfg.uri}\n`)

  if (existsSync(TMP)) unlinkSync(TMP)
  const r = await pullDb({ ...cfg, localPath: TMP })
  if (r === 'absent') {
    console.log('✗ 원격에 DB 가 없다. 먼저 db:push 를 실행할 것')
    process.exit(1)
  }

  const local = counts(cfg.localPath)
  const remote = counts(TMP)

  console.log(`${'항목'.padEnd(10)} ${'로컬'.padStart(6)} ${'원격'.padStart(6)}`)
  console.log('─'.repeat(26))
  let ok = true
  for (const k of Object.keys(local) as (keyof typeof local)[]) {
    const same = local[k] === remote[k]
    if (!same) ok = false
    console.log(`${k.padEnd(10)} ${String(local[k]).padStart(6)} ${String(remote[k]).padStart(6)}  ${same ? '✓' : '✗'}`)
  }

  const lkb = (statSync(cfg.localPath).size / 1024).toFixed(0)
  const rkb = (statSync(TMP).size / 1024).toFixed(0)
  console.log(`${'크기'.padEnd(10)} ${(lkb + 'KB').padStart(6)} ${(rkb + 'KB').padStart(6)}`)

  unlinkSync(TMP)
  console.log()
  console.log(ok ? '✓ 왕복 정상 — 원격 DB 가 로컬과 일치한다' : '✗ 불일치 — db:push 로 다시 올릴 것')
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
