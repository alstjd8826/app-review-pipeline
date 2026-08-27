/**
 * 슬랙에 실제로 보내지 않고 메시지 모양만 콘솔에 그린다.
 * 레이아웃을 확정한 뒤 전송을 붙인다.
 */
import { Store } from '../storage/db.js'
import { buildMainBlocks, buildThreadBlocks, consoleLink, consoleIds } from '../notify/slack.js'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import type { WorksheetWithSources } from '../sources/factory.js'

const PLAY_LIMIT = 350
const ASC_LIMIT = 5970

interface Block {
  type: string
  text?: { text: string }
  elements?: { text?: string; type: string }[]
}

/** Block Kit 을 터미널에 대충 그려본다 */
function render(blocks: unknown[], indent = '  ') {
  for (const b of blocks as Block[]) {
    if (b.type === 'divider') {
      console.log(`${indent}${'┈'.repeat(58)}`)
      continue
    }
    if (b.type === 'section' && b.text) {
      for (const l of b.text.text.split('\n')) {
        console.log(`${indent}${l.replace(/\*(.+?)\*/g, '$1').replace(/```/g, '')}`)
      }
      console.log()
      continue
    }
    if (b.type === 'context' && b.elements) {
      console.log(`${indent}\x1b[2m${b.elements.map((e) => e.text).join(' ')}\x1b[0m`)
      console.log()
      continue
    }
    if (b.type === 'actions') {
      console.log(`${indent}[ 답변 등록하러 가기 ]`)
      console.log()
    }
  }
}

function main() {
  const store = new Store()
  const w = loadWorksheet(worksheetPath()) as WorksheetWithSources
  const ids = consoleIds(w)
  const queue = store.reviewQueue()

  if (!queue.length) {
    console.log('검수 큐가 비어 있다. 먼저 pipeline-run 을 돌려라.')
    store.close()
    return
  }

  console.log(`검수 큐 ${queue.length}건\n`)

  for (const c of queue) {
    const limit = c.review.source === 'google-play' ? PLAY_LIMIT : ASC_LIMIT
    console.log('╔' + '═'.repeat(60))
    console.log(`║ ${w.notify?.channel ?? '(채널 미설정)'}`)
    console.log('╟' + '─'.repeat(60))
    const showDevice = Boolean(
      c.classification &&
        w.review_ui?.show_device_for?.includes(c.classification.category) &&
        c.review.device,
    )
    render(buildMainBlocks(c.review, showDevice), '║ ')
    console.log('╟' + '─'.repeat(60))
    console.log('║ ↳ 스레드')
    render(buildThreadBlocks(c, limit, w, ids), '║   ')
    const link = consoleLink(c.review, ids)
    console.log(`║   → ${link ? link.slice(0, 70) + (link.length > 70 ? '…' : '') : '(링크 없음)'}`)
    console.log('╚' + '═'.repeat(60))
    console.log()
  }

  store.close()
}

main()
