/**
 * 워크시트 설정으로 소스 어댑터를 만든다.
 *
 * CLI 가 자격증명·앱ID 를 직접 알지 못하게 한다.
 * 키를 교체할 때 설정 한 곳만 고치면 되도록.
 */
import { GooglePlaySource } from './google-play.js'
import { AppStoreSource } from './app-store.js'
import type { ReviewSource } from '../core/types.js'
import type { Worksheet } from '../core/config.js'

export interface SourceConfig {
  id: string
  status?: string
  // google-play
  package_name?: string
  credentials_path?: string
  report_bucket?: string
  backfill_from?: string | number
  /** 콘솔 링크 조립용. API 가 리뷰 링크를 주지 않아 필요하다 */
  console_developer_id?: string | number
  console_app_id?: string | number
  // app-store
  app_id?: string | number
  key_id?: string
  key_kind?: 'individual' | 'team'
  issuer_id?: string | null
  p8_path?: string
}

export interface WorksheetWithSources extends Worksheet {
  sources?: SourceConfig[]
}

export function sourceConfigs(w: WorksheetWithSources): SourceConfig[] {
  return (w.sources ?? []).filter((s) => s.status !== 'disabled')
}

export function findSource(w: WorksheetWithSources, id: string): SourceConfig | undefined {
  return sourceConfigs(w).find((s) => s.id === id)
}

/** 설정이 불완전하면 null. 호출부가 건너뛸 수 있게 한다 */
export function buildSource(cfg: SourceConfig): ReviewSource | null {
  if (cfg.id === 'google-play') {
    if (!cfg.package_name || !cfg.credentials_path) return null
    return new GooglePlaySource({
      packageName: cfg.package_name,
      credentialsPath: cfg.credentials_path,
      reportBucket: cfg.report_bucket,
    })
  }

  if (cfg.id === 'app-store') {
    if (!cfg.app_id || !cfg.key_id || !cfg.p8_path) return null
    const kind = cfg.key_kind ?? 'individual'
    if (kind === 'team' && !cfg.issuer_id) {
      throw new Error('app-store: 팀 키에는 issuer_id 가 필요하다 (개별 키는 sub, 팀 키는 iss)')
    }
    return new AppStoreSource({
      appId: String(cfg.app_id),
      p8Path: cfg.p8_path,
      keyId: cfg.key_id,
      kind,
      issuerId: cfg.issuer_id ?? undefined,
    })
  }

  return null
}

/** 워크시트에 정의된 모든 소스 */
export function buildAllSources(w: WorksheetWithSources): { cfg: SourceConfig; source: ReviewSource }[] {
  const out: { cfg: SourceConfig; source: ReviewSource }[] = []
  for (const cfg of sourceConfigs(w)) {
    const source = buildSource(cfg)
    if (source) out.push({ cfg, source })
  }
  return out
}
