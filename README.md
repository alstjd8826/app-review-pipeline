# app-review-pipeline

앱스토어·플레이스토어 고객 리뷰를 수집해 AI 가 분류하고 답변 초안을 만든 뒤,
**사람이 검수해서** 게시하는 파이프라인.

```
수집 → 정규화 → 분류 → 초안 → 가드레일 3단 → 슬랙 검수 → 게시 → 채택률 축적
```

**서비스 고유값은 전부 설정 파일에 있다.** 다른 앱에 적용할 때 코드는 건드리지 않는다.
건드리게 된다면 그건 설정으로 뺄 것이 남았다는 뜻이다.

---

## 이게 왜 있나

현대차그룹이 2026년 8월 공개한 '고객 리뷰 대응 자동화 솔루션' 사례를 보고 만들었다.
멀티 에이전트 · Human-in-the-Loop · 3단계 가드레일이라는 **구조는 공개됐지만**
가드레일의 실체, 택소노미 내용, 검수 UI 는 공개되지 않았다.

이 저장소는 **그 빈칸을 직접 설계해 채운 결과**다. 실제 운영 중인 앱에 적용하면서
겪은 함정을 [`GUIDEBOOK.md`](GUIDEBOOK.md) 에 전부 적었다.

| 문서 | 내용 |
|---|---|
| [`GUIDEBOOK.md`](GUIDEBOOK.md) | **핵심.** 왜 이렇게 만드는지, 어디서 걸리는지. 서비스 무관 |
| [`OPERATIONS.template.md`](OPERATIONS.template.md) | 운영·인수인계 문서 템플릿 |
| [`worksheet.example.yaml`](worksheet.example.yaml) | 서비스 고유값 템플릿 |

새로 시작한다면 `GUIDEBOOK.md` 0장부터 읽는다.

---

## 빠른 시작

```bash
npm install
cp worksheet.example.yaml worksheet.yaml
# worksheet.yaml 을 채운다
npm run worksheet:check    # 빠진 것 검사
npm run verify             # 자격증명·연결 확인
npm run run                # 수집 → 처리 → 알림
```

### 자격증명

`secrets/` 에 넣는다. `.gitignore` 대상이다.

| 파일 | 발급처 |
|---|---|
| `gcp-sa.json` | GCP 서비스 계정 JSON (Google Play) |
| `asc-key.p8` | App Store Connect API 키 |
| `slack-bot-token.txt` | Slack 봇 토큰 `xoxb-…` |

발급 절차는 `GUIDEBOOK.md` 2장에 화면 순서까지 있다.

⚠️ Google Play 는 **앱 권한**(리뷰 답글)과 **계정 권한**(보고서 다운로드)을 따로 준다.
계정 권한은 반영에 최대 24시간 걸린다.

---

## 명령

```bash
npm run ingest        # 스토어 → DB (+ 발행된 답변 대사)
npm run process       # 분류 · 초안 · 가드레일
npm run notify        # 슬랙 전송
npm run run           # 위를 순서대로 (자동 실행이 부르는 것)

npm run heartbeat     # 살아있음 신호
npm run verify        # 자격증명·LLM·슬랙 연결 확인
npm run preview       # 슬랙에 안 보내고 메시지 모양만 출력
npm run db:pull/push  # 원격 저장소 동기화
npm run db:verify     # 원격과 로컬이 일치하는지
```

**여러 번 돌려도 안전하다.** 이미 저장·처리·전송한 건은 건너뛴다.

| 옵션 | |
|---|---|
| `notify -- --dry` | 전송 대상만 확인 |
| `notify -- --one` | 한 건만 전송 (첫 설정 확인용) |
| `notify -- --force` | `skip_before` 무시 |
| `slack:reset` | 보낸 메시지 삭제 + 발송 기록 초기화 |

---

## 구조

```
src/
  core/       types · config(워크시트) · llm(교체 가능한 인터페이스)
  sources/    google-play · app-store · 인증 · CSV 파서 · factory
  agents/     classify · draft · guardrails
  storage/    schema.sql · db · remote(오브젝트 스토리지) · reconcile
  notify/     slack
  pipeline.ts 조립 — 분류 → 게이트 → 초안 → 검증
  cli/        실행 진입점
```

**새 플랫폼**은 `ReviewSource` 구현체 하나만 추가한다.
플랫폼 제약(답변 길이, 조회 가능 기간)을 어댑터가 들고 있어 뒤쪽에 분기가 생기지 않는다.

**다른 LLM**은 `LlmClient` 구현체를 추가한다. 헤드리스 CLI · API · 사내 게이트웨이가 같은 인터페이스다.

### 가드레일 3단

| | |
|---|---|
| ① 입력 게이트 | 위험한 리뷰는 **초안을 아예 만들지 않는다** (환불·법적 분쟁·안전) |
| ② 출력 검증 | 길이·금칙어·언어·링크·연락처·서명을 기계적으로 확인 |
| ③ 신뢰도 임계 | 분류 확신이 낮으면 자동 흐름에서 빼고 보류 |

**모든 차단은 "거부"가 아니라 "사람에게 넘김"이다.** 차단 사유는 사람이 읽을 문장으로 남긴다.

---

## 설계에서 중요한 것들

문서에 근거를 적어뒀지만, 실제로 여러 번 되돌아온 지점만 추린다.

**택소노미는 재사용하지 않는다.** 실제 리뷰를 100건(없으면 있는 만큼) 읽고 귀납적으로 만든다.
리뷰를 읽기 전에 카테고리를 정하면 반드시 현실과 어긋난다. — `GUIDEBOOK` 5.3

**길이는 상한이 아니라 목표로 준다.** 플랫폼 최대치를 넣으면 그만큼 길어져 기존 톤이 무너진다.
실측: 기존 답변이 192~403자인 서비스에서 상한 5970 을 주니 492자가 나왔다. — 7.4

**기존 답변이 있으면 그게 최고의 few-shot 재료다.** 새로 톤을 정의하는 것보다
있는 걸 뽑아 쓰는 편이 정확하고, 정책 합의도 짧아진다. — 7.3

**분류에 근거 인용을 요구한다.** 환각이 줄고, 검수자가 왜 그렇게 분류했는지 한눈에 본다. — 6.2

**볼륨이 작으면 정확도 대신 초안 채택률을 쓴다.** 정답 세트 100건이 없으면
정확도는 우연히 흔들려 오판을 부른다. — 11.2

**조용한 실패를 감지한다.** 리뷰가 드문 서비스는 "알림이 안 온다"와 "죽었다"를
구분할 수 없다. 주기적으로 살아있음을 알린다. — 13.4

---

## 알아둘 제약

| | Google Play | App Store Connect |
|---|---|---|
| 조회 범위 | **최근 7일** (과거는 리포트 CSV) | 제한 없음 |
| 답변 길이 | **350자** | 여유로움 |
| 리뷰 푸시(웹훅) | 없음 | 없음 |
| 기타 | 별점만 남긴 리뷰는 API 에 안 나옴 | 반영에 최대 24시간 |

⚠️ **리뷰 푸시를 지원하는 스토어가 없다.** 실시간이 아니라 폴링이며, 주기는 볼륨에 맞춘다.

자주 걸리는 문제 30여 가지는 `GUIDEBOOK.md` 부록 A 에 있다.

---

## 자동 실행

`.github/workflows/` 에 매일 파이프라인과 주간 heartbeat 가 들어 있다.
쓰려면 저장소에 다음을 등록한다.

| Secrets | |
|---|---|
| `GCP_SA_KEY` | 서비스 계정 JSON을 base64 로 |
| `ASC_P8` | `.p8` 키를 base64 로 |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 으로 발급 |

| Variables | |
|---|---|
| `SLACK_CHANNEL` | 실패 알림을 보낼 채널 |

```bash
base64 -i secrets/gcp-sa.json | gh secret set GCP_SA_KEY
```

⚠️ **`gh secret set` 에 이름을 반드시 붙인다.** 빠뜨리면 붙여넣은 값을 *이름* 으로 받아
**에러 메시지에 시크릿이 그대로 찍힌다.** (겪었다)

⚠️ **base64 파일명이 워크시트의 경로와 일치해야 한다.** 워크플로가 그 이름으로 복원한다.

macOS 로컬에서 돌리려면 `scripts/*.plist.template` 의 `__PROJECT_DIR__` 을 바꿔 쓴다.

⚠️ **헤드리스 CLI 로 LLM 을 부르면 클라우드에서는 장기 토큰이 필요하다.**
스케줄러 선택이 LLM 인증 방식에 묶인다. — `GUIDEBOOK` 12.3

---

## 라이선스

MIT
