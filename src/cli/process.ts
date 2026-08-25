/**
 * 저장된 미처리 리뷰를 분류·초안·가드레일까지 태우고 결과를 저장한다.
 * ingest 다음에 돌린다.
 */
import { Store } from '../storage/db.js'
import { ClaudeCliClient } from '../core/llm.js'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { processReview } from '../pipeline.js'
import type { ReplyExample } from '../agents/draft.js'

const PLAY_LIMIT = 350
const ASC_LIMIT = 5970

async function main() {
  const store = new Store()
  const w = loadWorksheet(worksheetPath())
  const llm = new ClaudeCliClient('sonnet')
  const target = (w.policy as { target_reply_length?: number }).target_reply_length ?? 280

  // 기존 답변을 few-shot 재료로
  const examples: ReplyExample[] = store
    .answeredReviews()
    .map((r) => ({ reviewBody: r.body, replyBody: r.existingReply!.body }))

  const pending = store.pendingReviews()
  console.log(`미처리 ${pending.length}건 · few-shot ${examples.length}건 · 목표 ${target}자\n`)

  for (const [i, review] of pending.entries()) {
    const limit = review.source === 'google-play' ? PLAY_LIMIT : ASC_LIMIT
    process.stdout.write(`  [${i + 1}/${pending.length}] ${review.source} ★${review.rating} `)
    try {
      const kase = await processReview(llm, w, review, {
        targetLength: target,
        platformLimit: limit,
        examples,
      })
      store.saveCase(kase)
      console.log(
        `→ ${kase.classification?.category} · ${kase.status}` +
          (kase.blocks.length ? ` (확인 ${kase.blocks.length})` : ''),
      )
    } catch (e) {
      console.log(`실패 — ${(e as Error).message.slice(0, 60)}`)
    }
  }

  const m = store.metrics()
  console.log(`\n상태 ${JSON.stringify(Object.fromEntries(m.statuses.map((s) => [s.status, s.n])))}`)
  console.log(`분류 ${JSON.stringify(Object.fromEntries(m.byCategory.map((c) => [c.category, c.n])))}`)
  if (m.blocksByRule.length) {
    console.log(`차단 ${m.blocksByRule.map((b) => `${b.stage}/${b.rule}:${b.n}`).join(' ')}`)
  }
  store.close()
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
