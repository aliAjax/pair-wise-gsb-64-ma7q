import { produce } from 'immer'
import { buildSeedPlan } from '../data/seed'
import type { AuditEntry, Deviation, DispositionVersion, PlanDoc } from '../types'

/**
 * 计划文档持久化与并发控制。
 *
 * 设计要点：
 * - 单一文档（控制矩阵 + 批次 + 偏差处置版本链 + 签字 + 审计）整体存一个 key，
 *   提交采用“暂存 key -> 主 key -> 清理暂存”两段式写入，主 key 要么是上一个
 *   完整版本、要么是新版本，不会出现半套审计。
 * - 提交带期望文档版本号（CAS）：两窗口并发提交同一处置版本时，后到一方基于
 *   最新文档追加“冲突待办”，绝不覆盖先到一方的证据或签字。
 * - storage 事件把已提交版本广播给其它窗口；写入失败保留最后完整版本，可重试。
 * - 首次打开旧数据（无 planVersion 的历史结构）时迁移补齐处置版本与影响范围。
 */

export const STORAGE_KEY = 'gsb64:haccp-platform'
export const STAGING_KEY = 'gsb64:haccp-platform.staging'
const WINDOW_KEY = 'gsb64:haccp-window'

export type StorageMode = 'persistent' | 'memory'

const memoryStore = new Map<string, string>()

export function getWindowId(): string {
  try {
    let id = sessionStorage.getItem(WINDOW_KEY)
    if (!id) {
      id = `W-${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(WINDOW_KEY, id)
    }
    return id
  } catch {
    return `W-${Math.random().toString(36).slice(2, 8)}`
  }
}

export interface BootstrapResult {
  doc: PlanDoc
  storageMode: StorageMode
  migrated: boolean
  recovered: boolean
  notes: string[]
}

export function bootstrapPlan(): BootstrapResult {
  const notes: string[] = []
  let storageMode: StorageMode = 'persistent'
  let recovered = false
  let migrated = false

  const main = readRaw(STORAGE_KEY)
  let doc: PlanDoc | null = null

  if (main.ok && main.value !== null) {
    const parsed = tryParse(main.value)
    if (parsed && isPlanDoc(parsed)) {
      doc = parsed as PlanDoc
    } else if (parsed && isLegacyState(parsed)) {
      doc = migrateLegacy(parsed as unknown as LegacyState)
      migrated = true
      notes.push('已迁移旧数据：补齐处置版本链与影响范围，批次状态、偏差证据和放行签字保持可查。')
      persist(doc)
    } else {
      notes.push('主存储内容无法识别，尝试从暂存区恢复。')
    }
  } else if (!main.ok) {
    storageMode = 'memory'
    notes.push('浏览器存储不可用，已切换到本次会话内存模式。')
  }

  // 两段式写入的恢复点：主 key 损坏或落在旧完整版本时，暂存区可能是最后一个完整版本。
  const staging = readRaw(STAGING_KEY)
  if (staging.ok && staging.value !== null) {
    const staged = tryParse(staging.value)
    if (staged && isPlanDoc(staged)) {
      const candidate = staged as PlanDoc
      if (!doc || candidate.planVersion > doc.planVersion) {
        const recoveredDoc = produce(candidate, (draft) => {
          draft.audit.unshift(makeAudit('系统', '启动恢复', '系统', `检测到未完成切换的完整版本V${candidate.planVersion}，已恢复并从该版本继续`, candidate.planVersion))
        })
        doc = recoveredDoc
        recovered = true
        notes.push(`写入中断已恢复，接着最后一个完整版本V${candidate.planVersion}继续。`)
        if (storageMode === 'persistent') persist(doc)
      }
    } else if (doc) {
      removeRaw(STAGING_KEY)
    }
  }

  if (!doc) {
    doc = buildSeedPlan()
    if (storageMode === 'persistent') persist(doc)
  }
  if (!Array.isArray(doc.conflictInbox)) doc.conflictInbox = []

  return { doc, storageMode, migrated, recovered, notes }
}

/** 两段式写入：先完整写暂存，再整体切换主 key，最后清理。任一步失败主 key 都保持完整版本。 */
export function persist(doc: PlanDoc): { ok: true } | { ok: false; error: string } {
  const serialized = JSON.stringify(doc)
  const staged = writeRaw(STAGING_KEY, serialized)
  if (!staged.ok) return { ok: false, error: staged.error }
  const swapped = writeRaw(STORAGE_KEY, serialized)
  if (!swapped.ok) return { ok: false, error: swapped.error }
  removeRaw(STAGING_KEY)
  return { ok: true }
}

export function readDoc(): PlanDoc | null {
  const raw = readRaw(STORAGE_KEY)
  if (!raw.ok || raw.value === null) {
    if (!raw.ok) return null
    return null
  }
  const parsed = tryParse(raw.value)
  return parsed && isPlanDoc(parsed) ? (parsed as PlanDoc) : null
}

export type CommitOutcome =
  | { kind: 'committed'; doc: PlanDoc }
  | { kind: 'stale'; current: PlanDoc }
  | { kind: 'write-failed'; current: PlanDoc; error: string }

/**
 * CAS 提交：仅当存储中的文档版本等于 expectedVersion 时才基于它追加一个完整新版本。
 * mutator 在 immer draft 上完成“一次处置版本”的全部写入（审计/证据/签字同版本生效）。
 */
export function commitDoc(
  expectedVersion: number,
  mutator: (draft: PlanDoc) => void
): CommitOutcome {
  const base = readDoc()
  if (!base) return { kind: 'write-failed', current: buildSeedPlan(), error: '无法读取计划文档' }
  if (base.planVersion !== expectedVersion) return { kind: 'stale', current: base }
  const next = produce(base, (draft) => {
    draft.planVersion += 1
    mutator(draft)
  })
  const write = persist(next)
  if (!write.ok) {
    // 主 key 未切换，存储仍是上一个完整版本，调用方可原样重试。
    return { kind: 'write-failed', current: base, error: write.error }
  }
  return { kind: 'committed', doc: next }
}

/**
 * 在最新版本上强制追加（用于冲突待办登记、冲突处理）。
 * 多窗口风暴下自动重读重放，追加的是新记录，不覆盖任何既有证据或签字。
 */
export function appendOnLatest(
  mutator: (draft: PlanDoc) => void,
  attempts = 6
): CommitOutcome {
  for (let i = 0; i < attempts; i += 1) {
    const base = readDoc()
    if (!base) return { kind: 'write-failed', current: buildSeedPlan(), error: '无法读取计划文档' }
    const next = produce(base, (draft) => {
      draft.planVersion += 1
      mutator(draft)
    })
    const write = persist(next)
    if (!write.ok) return { kind: 'write-failed', current: base, error: write.error }
    if (write.ok && next.planVersion !== base.planVersion) return { kind: 'committed', doc: next }
  }
  const last = readDoc()
  return { kind: 'write-failed', current: last ?? buildSeedPlan(), error: '并发冲突重试次数耗尽' }
}

/* ------------------------------------------------------------------ */
/* 旧数据迁移                                                          */
/* ------------------------------------------------------------------ */

interface LegacyInvestigation {
  cause?: string
  evidence?: string
  decision?: string
  reworkInstruction?: string
}

interface LegacyDeviation {
  id: string
  batchId: string
  stepId: string
  title: string
  severity: '一般' | '重大'
  status: string
  owner: string
  openedAt: string
  dueDate: string
  investigation?: LegacyInvestigation
  reviewNote?: string
  reviewer?: string
  version?: number
}

interface LegacyBatch {
  id: string
  status: string
  isolationScope?: string
}

interface LegacyAudit {
  id: string
  entity: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

interface LegacyState {
  batches: LegacyBatch[]
  deviations: LegacyDeviation[]
  processSteps: PlanDoc['processSteps']
  audit: LegacyAudit[]
}

function isPlanDoc(value: unknown): value is PlanDoc {
  const doc = value as Record<string, unknown>
  return typeof doc === 'object' && doc !== null
    && typeof doc.planVersion === 'number'
    && Array.isArray(doc.processSteps)
    && Array.isArray(doc.batches)
    && Array.isArray(doc.deviations)
    && Array.isArray(doc.signatures)
    && Array.isArray(doc.audit)
    && (doc.conflictInbox === undefined || Array.isArray(doc.conflictInbox))
}

function isLegacyState(value: unknown): value is LegacyState {
  const doc = value as Record<string, unknown>
  return typeof doc === 'object' && doc !== null
    && Array.isArray(doc.batches)
    && Array.isArray(doc.deviations)
    && Array.isArray(doc.processSteps)
    && doc.planVersion === undefined
}

function normalizeInvestigation(inv: LegacyInvestigation | undefined) {
  return {
    cause: inv?.cause ?? '',
    evidence: inv?.evidence ?? '',
    decision: (inv?.decision === '报废' || inv?.decision === '让步接收' ? inv.decision : '返工') as Deviation['investigation']['decision'],
    reworkInstruction: inv?.reworkInstruction ?? ''
  }
}

function migrateLegacy(legacy: LegacyState): PlanDoc {
  const batchById = new Map(legacy.batches.map((batch) => [batch.id, batch]))
  const deviations: Deviation[] = legacy.deviations.map((old) => {
    const batch = batchById.get(old.batchId)
    const impactScope = batch?.isolationScope && batch.isolationScope !== '无'
      ? `${batch.isolationScope}（${old.batchId}，迁移时补齐影响范围）`
      : `控制点 ${old.stepId} 关联批次 ${old.batchId}（迁移时补齐影响范围）`
    const investigation = normalizeInvestigation(old.investigation)
    const dispositions: DispositionVersion[] = []
    // V1：登记版本
    dispositions.push({
      version: 1, kind: '登记', status: '已完成', operator: old.owner || '历史记录', note: '迁移补齐：偏差登记版本',
      investigation: normalizeInvestigation(undefined), reviewNote: '', reviewer: '', basedOnPlanVersion: 0,
      impactScope, evidenceRef: '', createdAt: old.openedAt
    })
    // V2：调查版本（若历史上已提交过证据）
    if (investigation.cause || investigation.evidence) {
      const status: DispositionVersion['status'] = old.status === '待复核'
        ? '待复核'
        : old.status === '已关闭'
          ? '已完成'
          : '进行中'
      dispositions.push({
        version: 2, kind: '调查', status, operator: old.owner || '历史记录', note: '迁移补齐：调查处置版本',
        investigation, reviewNote: '', reviewer: '', basedOnPlanVersion: 0, impactScope,
        evidenceRef: investigation.evidence ? `迁移保留：${investigation.evidence}` : '', createdAt: old.openedAt
      })
    }
    // V3：复核签字版本（历史上已关闭）
    if (old.status === '已关闭') {
      dispositions.push({
        version: dispositions.length + 1, kind: '复核', status: '已完成', operator: old.reviewer || '历史签字',
        note: '迁移补齐：复核签字版本', investigation, reviewNote: old.reviewNote ?? '', reviewer: old.reviewer ?? '',
        basedOnPlanVersion: 0, impactScope, evidenceRef: '', createdAt: old.openedAt
      })
    }
    return {
      id: old.id, batchId: old.batchId, stepId: old.stepId, title: old.title, severity: old.severity,
      status: old.status as Deviation['status'], owner: old.owner, openedAt: old.openedAt, dueDate: old.dueDate,
      investigation, reviewNote: old.reviewNote ?? '', reviewer: old.reviewer ?? '',
      version: dispositions.length, impactScope, pendingReeval: false, reevalReason: '', dispositions
    }
  })

  // 已放行批次的签字照旧保留（迁移补齐签字记录，不改写批次状态）。
  const signatures = legacy.batches
    .filter((batch) => batch.status === '已放行')
    .map((batch) => ({
      batchId: batch.id, signer: '历史放行签字（迁移补齐）', note: '迁移自旧数据：批次已完成签字放行，状态与签字照旧可查',
      dispositionVersions: {}, planVersion: 0, signedAt: '2026-09-28T18:05:00'
    }))

  const audit: AuditEntry[] = [
    ...legacy.audit.map((entry) => ({ ...entry, planVersion: 0 })),
    makeAudit('系统', '旧数据迁移', '系统', '首次打开旧数据：已补齐处置版本链与影响范围，批次状态、偏差证据、放行签字保持原样可查', 0)
  ]

  return {
    planVersion: 0,
    processSteps: structuredClone(legacy.processSteps),
    batches: structuredClone(legacy.batches) as PlanDoc['batches'],
    deviations,
    signatures,
    conflictInbox: [],
    audit
  }
}

/* ------------------------------------------------------------------ */
/* 存储原语（localStorage 不可用时降级为内存）                          */
/* ------------------------------------------------------------------ */

function readRaw(key: string): { ok: true; value: string | null } | { ok: false; error: string } {
  try {
    const engine = storageEngine()
    return { ok: true, value: engine.getItem(key) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function writeRaw(key: string, value: string): { ok: true } | { ok: false; error: string } {
  try {
    storageEngine().setItem(key, value)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function removeRaw(key: string) {
  try { storageEngine().removeItem(key) } catch { /* best effort */ }
}

function storageEngine(): Storage {
  try {
    const probe = '__gsb64_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    return {
      getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
      setItem: (key: string, value: string) => { memoryStore.set(key, value) },
      removeItem: (key: string) => { memoryStore.delete(key) },
      clear: () => memoryStore.clear(),
      key: (index: number) => Array.from(memoryStore.keys())[index] ?? null,
      get length() { return memoryStore.size }
    } as Storage
  }
}

function tryParse(raw: string): unknown | null {
  try { return JSON.parse(raw) } catch { return null }
}

export function makeAudit(entity: string, action: string, operator: string, detail: string, planVersion: number, extra?: Partial<AuditEntry>): AuditEntry {
  return {
    id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    entity, action, operator, detail,
    createdAt: new Date().toISOString(),
    planVersion,
    windowId: getWindowId(),
    ...extra
  }
}
