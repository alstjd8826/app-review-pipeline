/**
 * 커밋 대상에 실제 시크릿 값이 섞였는지 검사한다.
 * secrets/ 파일의 내용 조각을 staged diff 에서 찾는다. 값 자체는 출력하지 않는다.
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const staged = execSync('git diff --cached', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })

let leaked = 0
for (const f of readdirSync('secrets')) {
  const content = readFileSync(join('secrets', f), 'utf8')

  // 파일 종류별로 특징적인 조각을 뽑는다
  const needles: string[] = []
  if (f.endsWith('.json')) {
    const j = JSON.parse(content) as { private_key?: string; client_email?: string }
    if (j.private_key) needles.push(j.private_key.slice(40, 120))
    if (j.client_email) needles.push(j.client_email)
  } else if (f.endsWith('.p8')) {
    const body = content.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
    needles.push(body.slice(20, 80))
  } else {
    needles.push(content.trim().slice(10, 60))
  }

  const hit = needles.some((n) => n.length > 10 && staged.includes(n))
  console.log(`  ${hit ? '⛔ 유출' : '✓ 안전'}  ${f}`)
  if (hit) leaked++
}

console.log()
if (leaked) {
  console.log(`⛔ ${leaked}개 파일의 내용이 커밋 대상에 포함돼 있다. 커밋하지 말 것.`)
  process.exit(1)
}
console.log('✓ 시크릿 값이 커밋 대상에 없다.')
