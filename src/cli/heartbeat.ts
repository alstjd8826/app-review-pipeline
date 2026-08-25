/**
 * 살아있음 신호. GUIDEBOOK.md 13.4
 *
 * 리뷰가 드문 서비스는 "알림이 안 온다"와 "파이프라인이 죽었다"를 구분할 수 없다.
 * 조용한 게 정상인 시스템은 조용함이 정상인지 고장인지 알려줘야 한다.
 *
 * --dry  전송 없이 내용만 출력
 */
import { readFileSync, existsSync } from 'node:fs'
import { Store } from '../storage/db.js'
import { loadWorksheet, worksheetPath, requireChannel } from '../core/config.js'
import { remoteConfig, remoteUpdatedAt } from '../storage/remote.js'

const LOG = 'logs/run.log'
// 하루 한 번 도는데 이만큼 넘으면 이상하다. 테스트용으로 덮어쓸 수 있다
const STALE_HOURS = Number(process.env.STALE_HOURS ?? 36)

const fmt = (d: Date) =>
  d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/**
 * 마지막으로 파이프라인이 정상 완료된 시각.
 *
 * 원격 DB 를 쓰면 그 객체의 갱신 시각이 곧 마지막 성공 시각이다.
 * DB 는 실행이 성공했을 때만 올라가기 때문이다.
 * CI 는 실행마다 파일시스템이 초기화되므로 로그 파일을 믿을 수 없다.
 */
async function lastSuccessfulRun(): Promise<Date | null> {
  try {
    const w = loadWorksheet(worksheetPath()) as Parameters<
      typeof remoteConfig
    >[0]
    const cfg = remoteConfig(w)
    if (cfg) {
      const at = await remoteUpdatedAt(cfg)
      if (at) return at
    }
  } catch {
    // 원격을 못 읽으면 로그로 넘어간다
  }
  return lastRunFromLog()
}

/** 로컬 실행(launchd) 용 대체 경로 */
function lastRunFromLog(): Date | null {
  if (!existsSync(LOG)) return null
  const lines = readFileSync(LOG, 'utf8').trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\[([\d-]+ [\d:]+)\].*완료/)
    if (m) return new Date(m[1]!.replace(' ', 'T') + '+09:00')
  }
  return null
}

async function post(channel: string, text: string, blocks: unknown[]): Promise<void> {
  const token = readFileSync('secrets/slack-bot-token.txt', 'utf8').trim()
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, blocks }),
  })
  const body = (await res.json()) as { ok: boolean; error?: string }
  if (!body.ok) throw new Error(`슬랙 전송 실패: ${body.error}`)
}

async function main() {
  const dry = process.argv.includes('--dry')
  const w = loadWorksheet(worksheetPath()) as Parameters<typeof requireChannel>[0]
  const store = new Store()

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const recent = store
    .allReviews()
    .filter((r) => r.collectedAt >= since)

  const m = store.metrics()
  const open = store.openCases()
  const last = await lastSuccessfulRun()

  const staleMs = last ? Date.now() - last.getTime() : Infinity
  const stale = staleMs > STALE_HOURS * 3600 * 1000
  const icon = stale ? '🔴' : '🟢'
  const status = stale ? '실행이 멈춘 것으로 보입니다' : '정상 동작 중'

  const lines = [
    `*이번 주 수집* ${recent.length}건`,
    `*미답변* ${open}건`,
    `*마지막 실행* ${last ? fmt(last) : '기록 없음'}`,
  ]

  if (m.adoptionRate !== null) {
    lines.push(`*초안 채택률* ${(m.adoptionRate * 100).toFixed(0)}% (${m.decided}건 기준)`)
  }
  if (m.authored) {
    lines.push(`*직접 작성* ${m.authored}건 (가드레일 차단분)`)
  }
  if (open > 0) {
    lines.push('', `아직 답변하지 않은 리뷰가 ${open}건 있습니다.`)
  }

  if (stale) {
    lines.push('', `⚠️ ${STALE_HOURS}시간 넘게 정상 완료 기록이 없습니다. 로그를 확인하세요.`)
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${icon} *앱 리뷰 파이프라인* — ${status}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ]

  if (dry) {
    console.log(`${icon} ${status}`)
    for (const l of lines) console.log('  ' + l.replace(/\*/g, ''))
  } else {
    await post(requireChannel(w), `${icon} 앱 리뷰 파이프라인 — ${status}`, blocks)
    console.log(`전송 완료 — ${status}`)
  }

  store.close()
}

main().catch((e) => {
  console.error('✗', (e as Error).message)
  process.exit(1)
})
