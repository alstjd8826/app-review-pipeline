/**
 * 리포트 버킷 접근 진단 (일회성).
 *
 * 403 은 "권한 없음" 과 "존재하지 않음" 을 구분해주지 않는다.
 * 여러 각도로 찔러서 어느 쪽인지 좁힌다.
 */
import { GoogleAuth, SCOPE_STORAGE_READ } from '../sources/google-auth.js'
import { loadWorksheet, worksheetPath } from '../core/config.js'
import { findSource, type WorksheetWithSources } from '../sources/factory.js'

async function main() {
  const w = loadWorksheet(worksheetPath()) as WorksheetWithSources
  const play = findSource(w, 'google-play')
  const CREDS = play?.credentials_path ?? ''
  const BUCKET = (process.argv[2] ?? play?.report_bucket ?? '').replace(/^gs:\/\//, '').replace(/\/.*$/, '')

  const auth = new GoogleAuth(CREDS)
  console.log(`서비스 계정: ${auth.clientEmail}`)
  console.log(`대상 버킷  : ${BUCKET}\n`)

  const token = await auth.token([SCOPE_STORAGE_READ])
  console.log('✓ devstorage.read_only 토큰 발급\n')

  const probe = async (label: string, url: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      items?: unknown[]
    }
    const mark = res.ok ? '✓' : '✗'
    console.log(`${mark} ${label}  HTTP ${res.status}`)
    if (!res.ok) console.log(`   ${body.error?.message?.slice(0, 110)}`)
    else if (body.items) console.log(`   ${body.items.length}개`)
    return res.status
  }

  // 버킷 메타데이터 — 존재 여부와 권한을 함께 본다
  await probe('버킷 정보', `https://storage.googleapis.com/storage/v1/b/${BUCKET}`)

  // 객체 목록 — 우리가 실제로 쓰는 호출
  await probe(
    '객체 목록',
    `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?maxResults=1`,
  )

  // 우리 소유 버킷은 되는지 (권한 체계 자체가 살아 있는지 확인)
  const sa = JSON.parse(
    (await import('node:fs')).readFileSync(CREDS, 'utf8'),
  ) as { project_id: string }
  await probe(
    `대조: 프로젝트 ${sa.project_id} 버킷 목록`,
    `https://storage.googleapis.com/storage/v1/b?project=${sa.project_id}`,
  )

  console.log('\n판단 기준')
  console.log('  버킷 정보 403 + 프로젝트 버킷 목록 200')
  console.log('    → 토큰·스코프는 정상. 이 버킷에 대한 권한만 없거나 이름이 틀렸다')
  console.log('  프로젝트 버킷 목록도 403')
  console.log('    → 서비스 계정 자체의 스토리지 권한 문제')
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
