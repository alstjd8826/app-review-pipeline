/**
 * SQLite 저장소. GUIDEBOOK.md 3장
 * 스키마는 schema.sql. 여기서는 접근만 담당한다.
 */
import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcile, type ReconcileResult } from './reconcile.js'
import type {
  Classification,
  GuardrailBlock,
  Review,
  ReviewCase,
  CaseStatus,
} from '../core/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const iso = (d: Date) => d.toISOString()

export interface CaseRow extends ReviewCase {
  review: Review
}

export class Store {
  private db: Database.Database

  constructor(path = 'data/pipeline.db') {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'))
    this.migrate()
  }

  /** CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 더해주지 않는다 */
  private migrate(): void {
    const cols = new Set(
      (this.db.pragma('table_info(review_case)') as { name: string }[]).map((c) => c.name),
    )
    for (const [name, type] of [
      ['slack_ts', 'TEXT'],
      ['slack_channel', 'TEXT'],
      ['notified_at', 'TEXT'],
    ] as const) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE review_case ADD COLUMN ${name} ${type}`)
    }
  }

  close() {
    this.db.close()
  }

  /**
   * 스토어에 답변이 달린 케이스를 정리한다.
   * 슬랙 검수 방식에서는 이게 유일한 "완료" 신호다.
   */
  reconcile(): ReconcileResult {
    return reconcile(this.db)
  }

  /** 아직 답변이 안 달린 채 남아 있는 건 */
  openCases(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM review_case c JOIN review r ON r.id = c.review_id
           WHERE r.reply_body IS NULL
             AND c.status IN ('BLOCKED','PENDING_REVIEW','DRAFTED')`,
        )
        .get() as { n: number }
    ).n
  }

  // ── 리뷰 ──────────────────────────────────

  /**
   * 원본 저장. 이미 있으면 갱신한다.
   * 사용자가 리뷰를 고치면 updated_at 이 바뀌므로 그때 반영된다.
   */
  upsertReview(r: Review): void {
    this.db
      .prepare(
        `INSERT INTO review (
           id, source, external_id, rating, title, body, language, country,
           app_version, device, authored_at, updated_at, collected_at,
           reply_body, reply_at, raw
         ) VALUES (
           @id, @source, @external_id, @rating, @title, @body, @language, @country,
           @app_version, @device, @authored_at, @updated_at, @collected_at,
           @reply_body, @reply_at, @raw
         )
         ON CONFLICT (source, external_id) DO UPDATE SET
           rating       = excluded.rating,
           title        = excluded.title,
           body         = excluded.body,
           updated_at   = excluded.updated_at,
           collected_at = excluded.collected_at,
           reply_body   = excluded.reply_body,
           reply_at     = excluded.reply_at,
           raw          = excluded.raw`,
      )
      .run({
        id: r.id,
        source: r.source,
        external_id: r.externalId,
        rating: r.rating,
        title: r.title ?? null,
        body: r.body,
        language: r.language,
        country: r.country ?? null,
        app_version: r.appVersion ?? null,
        device: r.device ?? null,
        authored_at: iso(r.authoredAt),
        updated_at: iso(r.updatedAt),
        collected_at: iso(r.collectedAt),
        reply_body: r.existingReply?.body ?? null,
        reply_at: r.existingReply ? iso(r.existingReply.repliedAt) : null,
        raw: JSON.stringify(r.raw),
      })
  }

  upsertReviews(rs: Review[]): number {
    const tx = this.db.transaction((list: Review[]) => {
      for (const r of list) this.upsertReview(r)
    })
    tx(rs)
    return rs.length
  }

  /** 아직 처리하지 않았고 스토어 답변도 없는 리뷰 */
  pendingReviews(): Review[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM review r
         LEFT JOIN review_case c ON c.review_id = r.id
         WHERE r.reply_body IS NULL AND c.review_id IS NULL
         ORDER BY r.authored_at DESC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map(toReview)
  }

  allReviews(): Review[] {
    const rows = this.db
      .prepare(`SELECT * FROM review ORDER BY authored_at DESC`)
      .all() as Record<string, unknown>[]
    return rows.map(toReview)
  }

  /** few-shot 재료 — 이미 답변이 달린 리뷰 */
  answeredReviews(): Review[] {
    const rows = this.db
      .prepare(`SELECT * FROM review WHERE reply_body IS NOT NULL ORDER BY authored_at DESC`)
      .all() as Record<string, unknown>[]
    return rows.map(toReview)
  }

  // ── 케이스 ────────────────────────────────

  saveCase(k: ReviewCase): void {
    const c = k.classification
    const d = k.draft
    this.db
      .prepare(
        `INSERT INTO review_case (
           review_id, status, category, tags, sentiment, urgency, confidence,
           evidence, classify_model, classified_at,
           draft_body, draft_chars, draft_model, drafted_at,
           final_body, edited_by_human, reviewer_note, decided_at, updated_at
         ) VALUES (
           @review_id, @status, @category, @tags, @sentiment, @urgency, @confidence,
           @evidence, @classify_model, @classified_at,
           @draft_body, @draft_chars, @draft_model, @drafted_at,
           @final_body, @edited_by_human, @reviewer_note, @decided_at, @updated_at
         )
         ON CONFLICT (review_id) DO UPDATE SET
           status         = excluded.status,
           category       = excluded.category,
           tags           = excluded.tags,
           sentiment      = excluded.sentiment,
           urgency        = excluded.urgency,
           confidence     = excluded.confidence,
           evidence       = excluded.evidence,
           classify_model = excluded.classify_model,
           classified_at  = excluded.classified_at,
           draft_body     = excluded.draft_body,
           draft_chars    = excluded.draft_chars,
           draft_model    = excluded.draft_model,
           drafted_at     = excluded.drafted_at,
           updated_at     = excluded.updated_at`,
      )
      .run({
        review_id: k.reviewId,
        status: k.status,
        category: c?.category ?? null,
        tags: c ? JSON.stringify(c.tags) : null,
        sentiment: c?.sentiment ?? null,
        urgency: c?.urgency ?? null,
        confidence: c?.confidence ?? null,
        evidence: c?.evidence ?? null,
        classify_model: c?.model ?? null,
        classified_at: c ? iso(c.classifiedAt) : null,
        draft_body: d?.body ?? null,
        draft_chars: d?.charCount ?? null,
        draft_model: d?.model ?? null,
        drafted_at: d ? iso(d.generatedAt) : null,
        final_body: k.finalBody ?? null,
        edited_by_human: k.editedByHuman ? 1 : 0,
        reviewer_note: k.reviewerNote ?? null,
        decided_at: k.decidedAt ? iso(k.decidedAt) : null,
        updated_at: iso(new Date()),
      })

    // 차단 기록은 매번 새로 쓴다
    this.db.prepare(`DELETE FROM guardrail_block WHERE review_id = ?`).run(k.reviewId)
    const ins = this.db.prepare(
      `INSERT INTO guardrail_block (review_id, stage, rule, detail, blocked_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const b of k.blocks) ins.run(k.reviewId, b.stage, b.rule, b.detail, iso(b.blockedAt))
  }

  /** 검수 큐. 손이 필요한 순서로 정렬한다 (GUIDEBOOK 9.4) */
  reviewQueue(): CaseRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, c.status, c.category, c.tags, c.sentiment, c.urgency,
                c.confidence, c.evidence, c.classify_model, c.classified_at,
                c.draft_body, c.draft_chars, c.draft_model, c.drafted_at,
                c.final_body, c.edited_by_human, c.reviewer_note
         FROM review_case c
         JOIN review r ON r.id = c.review_id
         WHERE c.status IN ('BLOCKED', 'PENDING_REVIEW', 'DRAFTED')
         ORDER BY
           CASE WHEN c.status = 'BLOCKED' THEN 0 ELSE 1 END,
           CASE c.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
           r.rating ASC,
           c.confidence ASC,
           r.authored_at ASC`,
      )
      .all() as Record<string, unknown>[]

    const blocks = this.db.prepare(
      `SELECT * FROM guardrail_block WHERE review_id = ? ORDER BY id`,
    )

    return rows.map((row) => ({
      review: toReview(row),
      reviewId: String(row.id),
      status: row.status as CaseStatus,
      classification: row.category
        ? ({
            reviewId: String(row.id),
            category: String(row.category),
            tags: JSON.parse(String(row.tags ?? '[]')) as string[],
            sentiment: row.sentiment,
            urgency: row.urgency,
            confidence: Number(row.confidence),
            evidence: String(row.evidence ?? ''),
            model: String(row.classify_model ?? ''),
            classifiedAt: new Date(String(row.classified_at)),
          } as Classification)
        : undefined,
      draft: row.draft_body
        ? {
            reviewId: String(row.id),
            body: String(row.draft_body),
            language: String(row.language),
            charCount: Number(row.draft_chars),
            model: String(row.draft_model ?? ''),
            generatedAt: new Date(String(row.drafted_at)),
          }
        : undefined,
      blocks: (blocks.all(row.id) as Record<string, unknown>[]).map((b) => ({
        stage: b.stage,
        rule: String(b.rule),
        detail: String(b.detail),
        blockedAt: new Date(String(b.blocked_at)),
      })) as GuardrailBlock[],
      finalBody: (row.final_body as string | null) ?? undefined,
      editedByHuman: Number(row.edited_by_human) === 1,
      reviewerNote: (row.reviewer_note as string | null) ?? undefined,
    }))
  }

  // ── 사람의 결정 ───────────────────────────

  /**
   * 승인. 초안과 최종본을 함께 남긴다.
   * 이 diff 가 개선의 유일한 재료다 (GUIDEBOOK 9.3, 11.3)
   */
  approve(reviewId: string, finalBody: string, note?: string): void {
    const row = this.db
      .prepare(`SELECT draft_body, category FROM review_case WHERE review_id = ?`)
      .get(reviewId) as { draft_body: string | null; category: string | null } | undefined
    const draftBody = row?.draft_body ?? null
    const changed = draftBody !== finalBody

    const at = iso(new Date())
    this.db
      .prepare(
        `UPDATE review_case
         SET status = 'APPROVED', final_body = ?, edited_by_human = ?,
             reviewer_note = ?, decided_at = ?, updated_at = ?
         WHERE review_id = ?`,
      )
      .run(finalBody, changed ? 1 : 0, note ?? null, at, at, reviewId)

    this.db
      .prepare(
        `INSERT INTO edit_history (review_id, draft_body, final_body, category, changed, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reviewId, draftBody, finalBody, row?.category ?? null, changed ? 1 : 0, at)
  }

  reject(reviewId: string, reason: string): void {
    const at = iso(new Date())
    this.db
      .prepare(
        `UPDATE review_case
         SET status = 'REJECTED', reject_reason = ?, decided_at = ?, updated_at = ?
         WHERE review_id = ?`,
      )
      .run(reason, at, at, reviewId)
  }

  markPublished(reviewId: string): void {
    const at = iso(new Date())
    this.db
      .prepare(
        `UPDATE review_case SET status = 'PUBLISHED', published_at = ?, updated_at = ?
         WHERE review_id = ?`,
      )
      .run(at, at, reviewId)
  }

  markPublishFailed(reviewId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE review_case SET status = 'PUBLISH_FAILED', publish_error = ?, updated_at = ?
         WHERE review_id = ?`,
      )
      .run(error, iso(new Date()), reviewId)
  }

  approvedForPublish(): CaseRow[] {
    return this.reviewQueueByStatus('APPROVED')
  }

  // ── 슬랙 알림 ─────────────────────────────

  /** 아직 알리지 않은 검수 대기 건 */
  unnotified(): CaseRow[] {
    const done = new Set(
      (
        this.db
          .prepare(`SELECT review_id FROM review_case WHERE notified_at IS NOT NULL`)
          .all() as { review_id: string }[]
      ).map((r) => r.review_id),
    )
    return this.reviewQueue().filter((c) => !done.has(c.reviewId))
  }

  markNotified(reviewId: string, ts: string, channel: string): void {
    this.db
      .prepare(
        `UPDATE review_case SET slack_ts = ?, slack_channel = ?, notified_at = ?
         WHERE review_id = ?`,
      )
      .run(ts, channel, iso(new Date()), reviewId)
  }

  /** 이미 알린 건. 메시지를 지우고 다시 보낼 때 쓴다 */
  notifiedCases(): { reviewId: string; slackTs: string; slackChannel: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT review_id, slack_ts, slack_channel FROM review_case
           WHERE notified_at IS NOT NULL AND slack_ts IS NOT NULL`,
        )
        .all() as { review_id: string; slack_ts: string; slack_channel: string | null }[]
    ).map((r) => ({ reviewId: r.review_id, slackTs: r.slack_ts, slackChannel: r.slack_channel }))
  }

  clearNotified(reviewId: string): void {
    this.db
      .prepare(`UPDATE review_case SET slack_ts = NULL, notified_at = NULL WHERE review_id = ?`)
      .run(reviewId)
  }

  private reviewQueueByStatus(status: CaseStatus): CaseRow[] {
    return this.reviewQueue().filter((c) => c.status === status)
  }

  // ── 지표 (GUIDEBOOK 11.1) ─────────────────

  metrics() {
    const statuses = this.db
      .prepare(`SELECT status, COUNT(*) n FROM review_case GROUP BY status`)
      .all() as { status: string; n: number }[]

    // 초안이 있었던 건만 채택률의 분모다.
    // 가드레일에 막혀 사람이 직접 쓴 건은 "초안을 안 썼다"가 아니라 "초안이 없었다"이다
    const adoption = this.db
      .prepare(
        `SELECT COUNT(*) total, SUM(CASE WHEN changed = 0 THEN 1 ELSE 0 END) unchanged
         FROM edit_history WHERE draft_body IS NOT NULL`,
      )
      .get() as { total: number; unchanged: number | null }

    const authored = (
      this.db
        .prepare(`SELECT COUNT(*) n FROM edit_history WHERE draft_body IS NULL`)
        .get() as { n: number }
    ).n

    const byRule = this.db
      .prepare(
        `SELECT stage, rule, COUNT(*) n FROM guardrail_block GROUP BY stage, rule ORDER BY n DESC`,
      )
      .all() as { stage: string; rule: string; n: number }[]

    const byCategory = this.db
      .prepare(
        `SELECT category, COUNT(*) n FROM review_case WHERE category IS NOT NULL
         GROUP BY category ORDER BY n DESC`,
      )
      .all() as { category: string; n: number }[]

    return {
      statuses,
      /** 초안 채택률 — 표본이 적어도 읽을 수 있는 지표 */
      adoptionRate: adoption.total ? (adoption.unchanged ?? 0) / adoption.total : null,
      decided: adoption.total,
      /** 초안 없이 사람이 직접 쓴 건 (가드레일 차단 등) */
      authored,
      openCases: this.openCases(),
      blocksByRule: byRule,
      byCategory,
    }
  }
}

function toReview(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    source: String(row.source),
    externalId: String(row.external_id),
    rating: Number(row.rating),
    title: (row.title as string | null) ?? undefined,
    body: String(row.body),
    language: String(row.language),
    country: (row.country as string | null) ?? undefined,
    appVersion: (row.app_version as string | null) ?? undefined,
    device: (row.device as string | null) ?? undefined,
    authoredAt: new Date(String(row.authored_at)),
    updatedAt: new Date(String(row.updated_at)),
    collectedAt: new Date(String(row.collected_at)),
    existingReply: row.reply_body
      ? { body: String(row.reply_body), repliedAt: new Date(String(row.reply_at)) }
      : undefined,
    raw: JSON.parse(String(row.raw)) as unknown,
  }
}
