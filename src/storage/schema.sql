-- 파이프라인 저장소. GUIDEBOOK.md 3장
-- 원본은 손대지 않고 통째로 보관한다. 파생 데이터는 다시 만들 수 있지만 원본은 못 되살린다.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 리뷰 원본 ────────────────────────────────
CREATE TABLE IF NOT EXISTS review (
  id            TEXT PRIMARY KEY,       -- "{source}:{externalId}"
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  rating        INTEGER NOT NULL,
  title         TEXT,
  body          TEXT NOT NULL,
  language      TEXT NOT NULL,
  country       TEXT,
  app_version   TEXT,
  device        TEXT,
  authored_at   TEXT NOT NULL,          -- ISO8601 UTC
  updated_at    TEXT NOT NULL,
  collected_at  TEXT NOT NULL,
  reply_body    TEXT,                   -- 스토어에 이미 달려 있는 답변
  reply_at      TEXT,
  raw           TEXT NOT NULL,          -- 원본 응답 JSON 통째로
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_review_authored ON review (authored_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_source   ON review (source);

-- ── 처리 상태 ────────────────────────────────
CREATE TABLE IF NOT EXISTS review_case (
  review_id       TEXT PRIMARY KEY REFERENCES review (id) ON DELETE CASCADE,
  status          TEXT NOT NULL,

  -- 분류
  category        TEXT,
  tags            TEXT,                 -- JSON 배열
  sentiment       TEXT,
  urgency         TEXT,
  confidence      REAL,
  evidence        TEXT,                 -- 검수 화면에서 하이라이트할 원문 구절
  classify_model  TEXT,
  classified_at   TEXT,

  -- 초안
  draft_body      TEXT,
  draft_chars     INTEGER,
  draft_model     TEXT,
  drafted_at      TEXT,

  -- 사람의 결정
  final_body      TEXT,
  edited_by_human INTEGER NOT NULL DEFAULT 0,
  reviewer_note   TEXT,
  reject_reason   TEXT,
  decided_at      TEXT,
  published_at    TEXT,
  publish_error   TEXT,

  -- 슬랙 알림. 중복 전송을 막고, 나중에 스레드를 갱신할 때 쓴다
  slack_ts        TEXT,
  slack_channel   TEXT,
  notified_at     TEXT,

  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_status ON review_case (status);

-- ── 가드레일 차단 기록 ───────────────────────
-- 차단 사유를 남기지 않으면 가드레일은 튜닝 불가능한 블랙박스가 된다 (8.4)
CREATE TABLE IF NOT EXISTS guardrail_block (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  TEXT NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,             -- input | output | confidence
  rule       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  blocked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_block_review ON guardrail_block (review_id);
CREATE INDEX IF NOT EXISTS idx_block_rule   ON guardrail_block (stage, rule);

-- ── 편집 이력 ────────────────────────────────
-- 초안이 무엇이었고 최종본이 무엇인지, 그 차이가 이 시스템의 유일한 개선 재료다 (9.3)
CREATE TABLE IF NOT EXISTS edit_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   TEXT NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  draft_body  TEXT,                     -- 차단으로 초안이 없으면 NULL
  final_body  TEXT NOT NULL,
  category    TEXT,
  changed     INTEGER NOT NULL,         -- 0 = 수정 없이 승인 (초안 채택률의 분자)
  decided_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edit_category ON edit_history (category);
