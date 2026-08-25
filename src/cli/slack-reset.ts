/**
 * 이미 보낸 슬랙 메시지를 지우고 알림 기록을 초기화한다.
 * 레이아웃을 고친 뒤 다시 보낼 때 쓴다.
 *
 * 봇은 자기가 올린 메시지만 지울 수 있다.
 */
import { readFileSync } from 'node:fs'
import { Store } from '../storage/db.js'

const token = readFileSync('secrets/slack-bot-token.txt', 'utf8').trim()

interface SlackResp {
  ok: boolean
  error?: string
  channel?: string
  channels?: { id: string; name: string }[]
  messages?: { ts: string; thread_ts?: string }[]
}

async function api(method: string, body: Record<string, unknown>): Promise<SlackResp> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as SlackResp
}

async function main() {
  const store = new Store()

  const sent = store.notifiedCases()
  if (!sent.length) {
    console.log('보낸 기록이 없다.')
    store.close()
    return
  }

  console.log(`보낸 기록 ${sent.length}건 정리\n`)

  for (const { reviewId, slackTs, slackChannel } of sent) {
    process.stdout.write(`  ${slackTs} `)

    // chat.delete 는 채널 이름이 아니라 ID 를 요구한다.
    // postMessage 응답에서 받아 저장해둔 값을 쓴다
    const ch = slackChannel
    if (!ch) {
      console.log('채널 ID 미기록 — 슬랙에서 직접 삭제해야 한다')
      store.clearNotified(reviewId)
      continue
    }

    // 스레드 답글부터 지운다. 부모를 먼저 지우면 답글을 못 찾는다
    const replies = await api('conversations.replies', {
      channel: ch,
      ts: slackTs,
    })
    const tsList = (replies.messages ?? []).map((m) => m.ts).reverse() // 자식부터

    let removed = 0
    for (const ts of tsList.length ? tsList : [slackTs]) {
      const r = await api('chat.delete', { channel: ch, ts })
      if (r.ok) removed++
      else if (r.error !== 'message_not_found') {
        console.log(`삭제 실패: ${r.error}`)
      }
    }

    store.clearNotified(reviewId)
    console.log(`→ ${removed}개 삭제, 기록 초기화`)
  }

  store.close()
  console.log('\n이제 notify 를 다시 돌리면 새 레이아웃으로 나간다.')
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
