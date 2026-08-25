/**
 * DB 파일을 GCS 에 보관한다.
 *
 * 클라우드 실행 환경은 파일시스템이 남지 않으므로,
 * 실행 시작에 내려받고 끝나면 올린다.
 *
 * ⚠️ 정식 DB 가 아니라 파일 동기화다. 아래 조건에서 깨진다.
 *    - 두 실행이 겹치면 나중 것이 앞의 것을 덮어쓴다
 *    - 실행 중 죽으면 그 회차 결과가 날아간다
 *    하루 한 번 도는 단일 작업이라면 문제가 없다.
 *    주기를 줄이거나 병렬 실행이 생기면 실제 DB(Turso 등)로 옮긴다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { GoogleAuth } from '../sources/google-auth.js'

const SCOPE_RW = 'https://www.googleapis.com/auth/devstorage.read_write'
const API = 'https://storage.googleapis.com'

export interface RemoteDbConfig {
  /** gs://버킷/경로 또는 버킷만 */
  uri: string
  credentialsPath: string
  localPath: string
}

function parseUri(uri: string): { bucket: string; object: string } {
  const clean = uri.replace(/^gs:\/\//, '')
  const slash = clean.indexOf('/')
  if (slash < 0) return { bucket: clean, object: 'pipeline.db' }
  return { bucket: clean.slice(0, slash), object: clean.slice(slash + 1) }
}

/** 원격 → 로컬. 원격에 없으면 새로 시작하는 것으로 본다 */
export async function pullDb(cfg: RemoteDbConfig): Promise<'downloaded' | 'absent'> {
  const { bucket, object } = parseUri(cfg.uri)
  const token = await new GoogleAuth(cfg.credentialsPath).token([SCOPE_RW])

  const url = `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (res.status === 404) return 'absent'
  if (!res.ok) throw new Error(`DB 내려받기 실패 ${res.status}: ${await res.text()}`)

  mkdirSync(dirname(cfg.localPath), { recursive: true })
  writeFileSync(cfg.localPath, Buffer.from(await res.arrayBuffer()))
  return 'downloaded'
}

/**
 * 원격 객체의 갱신 시각.
 *
 * DB 는 실행이 성공했을 때만 올라가므로, 이 시각이 곧 마지막 성공 실행 시각이다.
 * CI 환경은 실행마다 파일시스템이 초기화돼 로그를 못 믿는다.
 */
export async function remoteUpdatedAt(cfg: RemoteDbConfig): Promise<Date | null> {
  const { bucket, object } = parseUri(cfg.uri)
  const token = await new GoogleAuth(cfg.credentialsPath).token([SCOPE_RW])

  const url = `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`객체 정보 조회 실패 ${res.status}`)

  const meta = (await res.json()) as { updated?: string }
  return meta.updated ? new Date(meta.updated) : null
}

/** 로컬 → 원격 */
export async function pushDb(cfg: RemoteDbConfig): Promise<number> {
  if (!existsSync(cfg.localPath)) throw new Error(`로컬 DB 가 없다: ${cfg.localPath}`)

  const { bucket, object } = parseUri(cfg.uri)
  const token = await new GoogleAuth(cfg.credentialsPath).token([SCOPE_RW])
  const body = readFileSync(cfg.localPath)

  const url =
    `${API}/upload/storage/v1/b/${bucket}/o` +
    `?uploadType=media&name=${encodeURIComponent(object)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(body),
  })
  if (!res.ok) throw new Error(`DB 올리기 실패 ${res.status}: ${await res.text()}`)
  return body.length
}

/** 워크시트에서 설정을 읽는다. 미설정이면 null — 로컬 파일만 쓴다 */
export function remoteConfig(w: {
  impl?: { storage_remote?: string; storage_path?: string }
  sources?: { id: string; credentials_path?: string }[]
}): RemoteDbConfig | null {
  const uri = w.impl?.storage_remote
  if (!uri) return null

  const creds = w.sources?.find((s) => s.id === 'google-play')?.credentials_path
  if (!creds) throw new Error('storage_remote 를 쓰려면 google-play 소스의 credentials_path 가 필요하다')

  return {
    uri,
    credentialsPath: creds,
    localPath: w.impl?.storage_path ?? 'data/pipeline.db',
  }
}
