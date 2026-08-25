/**
 * 검수 대기 건을 슬랙에 알린다.
 * 이미 보낸 건은 다시 보내지 않는다.
 *
 * --dry    실제 전송 없이 대상만 출력
 * --one    한 건만 보낸다 (첫 전송 확인용)
 * --force  skip_before 필터를 무시한다. 과거 리뷰를 일부러 보낼 때만
 */
import { Store } from '../storage/db.js'
import { SlackNotifier } from '../notify/slack.js'
import { loadWorksheet, worksheetPath, requireChannel } from '../core/config.js'
import { findSource, type WorksheetWithSources } from '../sources/factory.js'

const PLAY_LIMIT = 350
const ASC_LIMIT = 5970

async function main() {
  const dry = process.argv.includes('--dry')
  const one = process.argv.includes('--one')
  const force = process.argv.includes('--force')

  const store = new Store()
  const w = loadWorksheet(worksheetPath()) as WorksheetWithSources
  const appStoreId = findSource(w, 'app-store')?.app_id
  const CHANNEL = w.notify?.channel ?? requireChannel(w)

  let targets = store.unnotified()

  // 백필로 들어온 과거 리뷰는 전송하지 않는다.
  // DB 에는 남아 있으므로 택소노미·프롬프트 개선에는 그대로 쓰인다
  const cutoff =
    !force && w.notify?.skip_before
      ? new Date(`${w.notify.skip_before}T00:00:00+09:00`)
      : null
  if (force) console.log('--force: skip_before 필터를 무시한다')
  let skipped = 0
  if (cutoff) {
    const before = targets.length
    targets = targets.filter((c) => c.review.authoredAt >= cutoff)
    skipped = before - targets.length
  }

  if (skipped) {
    console.log(`과거 리뷰 ${skipped}건은 전송 제외 (${w.notify!.skip_before} 이전)`)
  }

  if (!targets.length) {
    console.log('보낼 것이 없다. (이미 다 알렸거나 검수 큐가 비어 있다)')
    store.close()
    return
  }

  if (one) targets = targets.slice(0, 1)

  console.log(`대상 ${targets.length}건 → ${CHANNEL}${dry ? '  [dry-run]' : ''}\n`)

  if (dry) {
    for (const c of targets) {
      console.log(
        `  ★${c.review.rating} ${c.review.source} ${c.classification?.category ?? '?'} ` +
          `${c.draft ? `초안 ${c.draft.charCount}자` : '초안 없음'}`,
      )
    }
    store.close()
    return
  }

  const slack = new SlackNotifier(CHANNEL)

  for (const c of targets) {
    const limit = c.review.source === 'google-play' ? PLAY_LIMIT : ASC_LIMIT
    process.stdout.write(`  ★${c.review.rating} ${c.review.source} `)
    try {
      const { ts, channel } = await slack.notify(c, limit, w, appStoreId ? String(appStoreId) : undefined)
      store.markNotified(c.reviewId, ts, channel)
      console.log(`→ 전송 완료`)
    } catch (e) {
      console.log(`→ ${(e as Error).message}`)
      break // 첫 실패에서 멈춘다. 설정 문제면 나머지도 다 실패한다
    }
  }

  store.close()
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
