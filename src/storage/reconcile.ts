/**
 * 대사(reconcile) — 스토어에 실제로 달린 답변을 우리 상태에 반영한다.
 *
 * 슬랙 검수 방식에서는 사람이 콘솔에서 직접 답변을 등록하므로,
 * 우리 쪽에는 "승인했다"는 신호가 오지 않는다.
 * 다음 수집 때 existingReply 로 되읽어 대사하는 것이 유일한 경로다.
 *
 * 이걸 안 하면
 *   - 케이스가 검수 큐에서 영원히 빠지지 않는다
 *   - 초안 채택률을 측정할 수 없다
 *   - 미답변 방치를 알아챌 수 없다
 *
 * GUIDEBOOK 9.7
 */
import type Database from 'better-sqlite3'

export interface ReconcileResult {
  published: number
  /** 초안 그대로 발행된 건 */
  unchanged: number
  /** 사람이 고쳐서 발행한 건 */
  edited: number
  /** 초안 없이 사람이 직접 쓴 건 (가드레일 차단 등) */
  authored: number
}

/**
 * 스토어에 답변이 달렸는데 아직 처리 중으로 남아 있는 케이스를 정리한다.
 * ingest 직후에 부른다.
 */
export function reconcile(db: Database.Database): ReconcileResult {
  const rows = db
    .prepare(
      `SELECT c.review_id, c.draft_body, c.category, r.reply_body, r.reply_at
       FROM review_case c
       JOIN review r ON r.id = c.review_id
       WHERE r.reply_body IS NOT NULL
         AND c.status IN ('COLLECTED','CLASSIFIED','DRAFTED','BLOCKED','PENDING_REVIEW','APPROVED')`,
    )
    .all() as {
    review_id: string
    draft_body: string | null
    category: string | null
    reply_body: string
    reply_at: string | null
  }[]

  const result: ReconcileResult = { published: 0, unchanged: 0, edited: 0, authored: 0 }
  if (!rows.length) return result

  const markPublished = db.prepare(
    `UPDATE review_case
     SET status = 'PUBLISHED',
         final_body = ?,
         edited_by_human = ?,
         decided_at = COALESCE(decided_at, ?),
         published_at = ?,
         updated_at = ?
     WHERE review_id = ?`,
  )
  const addHistory = db.prepare(
    `INSERT INTO edit_history (review_id, draft_body, final_body, category, changed, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const already = db.prepare(`SELECT 1 FROM edit_history WHERE review_id = ? LIMIT 1`)

  const tx = db.transaction(() => {
    for (const r of rows) {
      const at = r.reply_at ?? new Date().toISOString()
      const final = r.reply_body.trim()
      const draft = r.draft_body?.trim() ?? null

      // 초안이 없던 건(가드레일 차단)은 사람이 직접 쓴 것으로 본다
      const changed = draft === null ? true : draft !== final

      markPublished.run(final, changed ? 1 : 0, at, at, new Date().toISOString(), r.review_id)

      // 같은 리뷰를 두 번 집계하지 않는다
      if (!already.get(r.review_id)) {
        addHistory.run(r.review_id, draft, final, r.category, changed ? 1 : 0, at)
      }

      result.published++
      if (draft === null) result.authored++
      else if (changed) result.edited++
      else result.unchanged++
    }
  })
  tx()

  return result
}
