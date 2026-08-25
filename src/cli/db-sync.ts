/**
 * DB 를 원격 저장소와 동기화한다.
 *
 *   db-sync pull   원격 → 로컬 (실행 시작)
 *   db-sync push   로컬 → 원격 (실행 종료)
 *
 * 워크시트에 impl.storage_remote 가 없으면 아무 일도 하지 않는다.
 * 로컬 개발에서는 설정하지 않고 쓰면 된다.
 */
import { statSync, existsSync } from 'node:fs'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { pullDb, pushDb, remoteConfig } from '../storage/remote.js'

const mode = process.argv[2]

async function main() {
  const WORKSHEET = worksheetPath()
  if (mode !== 'pull' && mode !== 'push') {
    console.error('사용법: db-sync <pull|push>')
    process.exit(1)
  }

  const w = loadWorksheet(WORKSHEET) as Parameters<typeof remoteConfig>[0]
  const cfg = remoteConfig(w)

  if (!cfg) {
    console.log('원격 저장소 미설정 — 로컬 파일만 사용한다')
    return
  }

  if (mode === 'pull') {
    const r = await pullDb(cfg)
    if (r === 'absent') {
      console.log(`원격에 DB 가 없다. 새로 시작한다 (${cfg.uri})`)
    } else {
      const kb = (statSync(cfg.localPath).size / 1024).toFixed(0)
      console.log(`내려받기 완료 ${kb}KB ← ${cfg.uri}`)
    }
    return
  }

  if (!existsSync(cfg.localPath)) {
    console.log('로컬 DB 가 없다. 올릴 것이 없다')
    return
  }
  const bytes = await pushDb(cfg)
  console.log(`올리기 완료 ${(bytes / 1024).toFixed(0)}KB → ${cfg.uri}`)
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
