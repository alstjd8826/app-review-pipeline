/**
 * LLM 호출부. GUIDEBOOK.md 2.3
 * 구현체를 갈아끼울 수 있도록 인터페이스로 분리한다.
 */
import { spawn } from 'node:child_process'

export interface LlmClient {
  readonly name: string
  complete(prompt: string): Promise<string>
}

/**
 * 이미 설치된 Claude Code 를 헤드리스로 부른다.
 * 별도 API 키가 필요 없다 — 구독으로 동작한다.
 */
export class ClaudeCliClient implements LlmClient {
  readonly name: string

  constructor(private model = 'sonnet') {
    this.name = `claude-cli:${model}`
  }

  complete(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'claude',
        ['-p', '--output-format', 'json', '--model', this.model],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )

      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))

      child.on('error', (e) => reject(new Error(`claude 실행 실패: ${e.message}`)))
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`claude 종료코드 ${code}: ${err.slice(0, 300)}`))
        try {
          // --output-format json 은 봉투를 돌려준다. result 안에 본문이 있다
          const envelope = JSON.parse(out) as { result?: string; is_error?: boolean }
          resolve(envelope.result ?? out)
        } catch {
          resolve(out) // 봉투가 아니면 원문 그대로
        }
      })

      child.stdin.write(prompt)
      child.stdin.end()
    })
  }
}

/** 모델이 ```json 펜스로 감싸 내놓는 경우가 잦다. 벗겨낸다 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.search(/[[{]/)
  if (start < 0) throw new Error(`JSON 을 찾을 수 없다: ${text.slice(0, 200)}`)
  return JSON.parse(candidate.slice(start)) as T
}
