/**
 * Play Console 리뷰 리포트 CSV 파서.
 *
 * ⚠️ 이 CSV 는 UTF-16 LE + BOM 이다. UTF-8 로 읽으면 통째로 깨진다.
 *    GUIDEBOOK.md 4.3
 */
import type { RawReview } from '../core/types.js'

/** BOM 을 보고 인코딩을 판별해 문자열로 만든다 */
export function decodeCsv(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE — 바이트를 뒤집어 LE 로 읽는다
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  return buf.toString('utf8')
}

/** 따옴표 안의 쉼표와 줄바꿈을 지키는 최소 CSV 파서 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some((f) => f !== '')) rows.push(row)
  }
  return rows
}

/** Review Link 의 reviewId 파라미터. API 가 주는 reviewId 와 같은 값이다 */
function extractReviewId(link: string): string | null {
  return new URLSearchParams(link.split('?')[1] ?? '').get('reviewId')
}

export function parseReviewsCsv(buf: Buffer): RawReview[] {
  const rows = parseCsvRows(decodeCsv(buf))
  if (rows.length < 2) return []

  const header = rows[0]!.map((h) => h.replace(/^﻿/, '').trim())
  const col = (name: string) => header.indexOf(name)

  const idx = {
    version: col('App Version Name'),
    lang: col('Reviewer Language'),
    device: col('Device'),
    submitMs: col('Review Submit Millis Since Epoch'),
    updateMs: col('Review Last Update Millis Since Epoch'),
    rating: col('Star Rating'),
    title: col('Review Title'),
    text: col('Review Text'),
    replyMs: col('Developer Reply Millis Since Epoch'),
    replyText: col('Developer Reply Text'),
    link: col('Review Link'),
  }

  if (idx.link < 0 || idx.text < 0) {
    throw new Error(`예상과 다른 CSV 헤더: ${header.join(', ')}`)
  }

  const out: RawReview[] = []
  for (const r of rows.slice(1)) {
    const link = r[idx.link] ?? ''
    const externalId = extractReviewId(link)
    if (!externalId) continue

    const body = (r[idx.text] ?? '').trim()
    const title = (r[idx.title] ?? '').trim()
    // 별점만 남긴 행은 본문이 비어 있다. API 와 동작을 맞추기 위해 제외한다
    if (!body && !title) continue

    const submitMs = Number(r[idx.submitMs] ?? 0)
    const updateMs = Number(r[idx.updateMs] ?? 0) || submitMs
    const replyText = (r[idx.replyText] ?? '').trim()
    const replyMs = Number(r[idx.replyMs] ?? 0)

    out.push({
      externalId,
      rating: Number(r[idx.rating] ?? 0),
      title: title || undefined,
      body,
      language: r[idx.lang] || 'unknown',
      appVersion: r[idx.version] || undefined,
      device: r[idx.device] || undefined,
      authoredAt: new Date(submitMs),
      updatedAt: new Date(updateMs),
      existingReply: replyText ? { body: replyText, repliedAt: new Date(replyMs) } : undefined,
      raw: Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])),
    })
  }
  return out
}
