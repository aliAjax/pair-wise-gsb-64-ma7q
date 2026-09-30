import { nanoid } from '@reduxjs/toolkit'
import type {
  AuditEntry, Batch, BatchStatus, ConflictRecord, Deviation,
  DispositionKind, DispositionVersion, HaccpState, Investigation, ProcessStep
} from '../types'
import { seedAudit, seedBatches, seedDeviations, processSteps as seedSteps } from '../data/seed'

/* ------------------------------------------------------------------ */
/* 处置意图：两个窗口各自编辑时持有的是“基于某版本的意图”，不是直接改写 */
/* ------------------------------------------------------------------ */

export type Intent =
  | { type: 'matrixChange'; stepId: string; limit: string; frequency: string; correctiveAction: string }
  | { type: 'deviationCreate'; batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }
  | { type: 'investigationSave'; deviationId: string; investigation: Investigation }
  | { type: 'review'; deviationId: string; approved: boolean; note: string }
  | { type: 'batchTransition'; batchId: string; status: BatchStatus }
  | { type: 'releaseSign'; batchId: string }

export interface CommitContext { origin: string; operator: string }

export type CommitResult =
  | { ok: true; state: HaccpState; seq: number }
  | { ok: false; reason: 'conflict'; state: HaccpState; conflictId: string }
  | { ok: false; reason: 'error'; state: HaccpState; message: string }

/* ------------------------------------------------------------------ */
/* 旧数据迁移：首次打开补齐处置版本与影响范围，原数据一律保留可查        */
/* ------------------------------------------------------------------ */

interface LegacyState {
  batches: Array<Omit<Batch, 'dispositionSeq' | 'release'>>
  deviations: Array<Omit<Deviation, 'dispositionSeq' | 'reassessFromSeq' | 'reassessReason'>>
  processSteps: Array<Omit<ProcessStep, 'dispositionSeq'>>
  audit: Array<Omit<AuditEntry, 'dispositionSeq'>>
  batchFilter?: string
  batchStatus?: BatchStatus | '全部'
  selectedBatchId?: string | null
}

function isLegacy(raw: unknown): raw is LegacyState {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as { schemaVersion?: number; batches?: unknown[]; deviations?: unknown[] }
  return value.schemaVersion !== 2 && Array.isArray(value.batches) && Array.isArray(value.deviations)
}

export function migrate(raw: unknown): HaccpState {
  // 已是 v2 快照：原样直通（补齐可选数组，保持旧窗口写入的版本链）
  if (raw && typeof raw === 'object' && (raw as { schemaVersion?: number }).schemaVersion === 2) {
    const value = raw as HaccpState
    value.conflicts ??= []
    value.versions ??= []
    value.windowId = undefined
    return value
  }
  const legacy: LegacyState = isLegacy(raw)
    ? raw
    : { batches: seedBatches, deviations: seedDeviations, processSteps: seedSteps, audit: seedAudit }

  const batches: Batch[] = legacy.batches.map((batch) => ({
    ...batch,
    dispositionSeq: 1,
    // 已完成签字放行的批次：补录历史签字，版本依据冻结为 V1
    release: batch.status === '已放行'
      ? { seq: 1, operator: '历史签字（迁移补录）', signedAt: batch.producedAt, basisSeq: 1 }
      : undefined
  }))
  const deviations: Deviation[] = legacy.deviations.map((dev) => ({ ...dev, dispositionSeq: 1 }))
  const steps: ProcessStep[] = legacy.processSteps.map((step) => ({ ...step, dispositionSeq: 1 }))
  // 原有审计条目原样保留，仅挂到迁移版本下，证据/签字记录不丢不改
  const audit: AuditEntry[] = legacy.audit.map((entry) => ({ ...entry, dispositionSeq: 1 }))

  const now = new Date().toISOString()
  audit.unshift({
    id: nanoid(), dispositionSeq: 1, entity: '系统', action: '旧数据迁移', operator: '系统',
    detail: '补齐处置版本链与影响范围；批次状态、偏差证据、放行签字保持原样可查',
    createdAt: now
  })

  const version: DispositionVersion = {
    seq: 1, kind: '迁移', origin: '系统', operator: '系统', createdAt: now,
    summary: '旧版数据首次打开迁移：补齐处置版本 V1 与影响范围，历史状态/证据/签字冻结保留',
    impact: {
      batches: batches.map((item) => item.id),
      deviations: deviations.map((item) => item.id),
      steps: steps.map((item) => item.id),
      frozenReleased: batches.filter((item) => item.status === '已放行').map((item) => item.id)
    }
  }

  return {
    schemaVersion: 2,
    dispositionSeq: 1,
    versions: [version],
    conflicts: [],
    batches,
    deviations,
    processSteps: steps,
    audit,
    batchFilter: legacy.batchFilter ?? '',
    batchStatus: legacy.batchStatus ?? '全部',
    selectedBatchId: legacy.selectedBatchId ?? batches[0]?.id ?? null
  }
}

/* ------------------------------------------------------------------ */
/* 版本提交：OCC 基准校验 → 整版原子应用；并发后到方进入冲突待办         */
/* ------------------------------------------------------------------ */

export function buildCommit(prev: HaccpState, intent: Intent, baseSeq: number, ctx: CommitContext): CommitResult {
  // 两窗口同时提交同一处置版本：基准已被对方推进 → 后到方不覆盖，转冲突待办
  if (baseSeq !== prev.dispositionSeq) {
    return registerConflict(prev, intent, baseSeq, ctx)
  }

  const invalid = validate(prev, intent)
  if (invalid) return { ok: false, reason: 'error', state: prev, message: invalid }

  const state: HaccpState = structuredClone(prev)
  const seq = state.dispositionSeq + 1
  const now = new Date().toISOString()
  const applied = applyIntent(state, intent, seq, ctx, now, '')
  pushVersion(state, seq, intentKind(intent), ctx, now, applied.summary, impactOf(intent, state, seq, applied.frozenReleased))
  state.dispositionSeq = seq
  return { ok: true, state, seq }
}

function registerConflict(prev: HaccpState, intent: Intent, baseSeq: number, ctx: CommitContext): CommitResult {
  const state: HaccpState = structuredClone(prev)
  const seq = state.dispositionSeq + 1
  const now = new Date().toISOString()
  const conflictId = `CFL-${nanoid(8)}`
  const conflict: ConflictRecord = {
    id: conflictId,
    baseSeq,
    winnerSeq: prev.dispositionSeq,
    origin: ctx.origin,
    operator: ctx.operator,
    createdAt: now,
    kind: intentKind(intent),
    summary: intentSummary(intent),
    intent,
    status: '待处理'
  }
  state.conflicts.unshift(conflict)
  pushAudit(state, seq, conflictId, '并发冲突待办', ctx.operator,
    `窗口${ctx.origin}基于V${baseSeq}的「${intentSummary(intent)}」晚于V${prev.dispositionSeq}提交，已挂起，未覆盖对方证据或签字`, now)
  pushVersion(state, seq, '冲突登记', ctx, now,
    `并发提交冲突登记：${conflict.summary}`,
    { batches: intentBatches(intent), deviations: intentDeviations(intent), steps: intentSteps(intent), frozenReleased: [] })
  state.dispositionSeq = seq
  return { ok: false, reason: 'conflict', state, conflictId }
}

export function resolveConflict(prev: HaccpState, conflictId: string, action: 'continue' | 'abandon', ctx: CommitContext): CommitResult {
  const conflict = prev.conflicts.find((item) => item.id === conflictId)
  if (!conflict) return { ok: false, reason: 'error', state: prev, message: '冲突待办不存在' }
  if (conflict.status !== '待处理') return { ok: false, reason: 'error', state: prev, message: '该冲突待办已处理' }

  const state: HaccpState = structuredClone(prev)
  const seq = state.dispositionSeq + 1
  const now = new Date().toISOString()
  const record = state.conflicts.find((item) => item.id === conflictId)!

  if (action === 'abandon') {
    record.status = '已放弃'
    record.resolvedAt = now
    record.resolvedSeq = seq
    pushAudit(state, seq, conflictId, '放弃冲突提交', ctx.operator,
      `窗口${ctx.origin}放弃基于V${conflict.baseSeq}的「${conflict.summary}」，对方V${conflict.winnerSeq}的证据与签字保持有效`, now)
    pushVersion(state, seq, '放弃冲突', ctx, now, `放弃冲突待办 ${conflictId}：${conflict.summary}`,
      { batches: [], deviations: [], steps: [], frozenReleased: [] })
    state.dispositionSeq = seq
    return { ok: true, state, seq }
  }

  // 续提：把原处置意图重放到当前最新完整版本之上（变基），不再覆盖对方内容
  const intent = conflict.intent as Intent
  const invalid = validate(state, intent)
  if (invalid) return { ok: false, reason: 'error', state: prev, message: invalid }
  const applied = applyIntent(state, intent, seq, ctx, now, `冲突续提（原基于V${conflict.baseSeq}）：`)
  record.status = '已续提'
  record.resolvedAt = now
  record.resolvedSeq = seq
  pushAudit(state, seq, conflictId, '冲突续提', ctx.operator,
    `窗口${ctx.origin}的处置已变基到V${seq}重做，对方V${conflict.winnerSeq}的证据与签字保留`, now)
  pushVersion(state, seq, '冲突续提', ctx, now, applied.summary, impactOf(intent, state, seq, applied.frozenReleased))
  state.dispositionSeq = seq
  return { ok: true, state, seq }
}

/* ------------------------------------------------------------------ */
/* 校验                                                               */
/* ------------------------------------------------------------------ */

function validate(state: HaccpState, intent: Intent): string | null {
  switch (intent.type) {
    case 'matrixChange': {
      const step = state.processSteps.find((item) => item.id === intent.stepId)
      if (!step) return '控制点不存在'
      if (!intent.limit.trim() || !intent.correctiveAction.trim()) return '关键限值与纠偏措施不得为空'
      if (step.limit === intent.limit && step.frequency === intent.frequency && step.correctiveAction === intent.correctiveAction)
        return '控制矩阵没有实际变更'
      return null
    }
    case 'deviationCreate': {
      const batch = state.batches.find((item) => item.id === intent.batchId)
      if (!batch) return '批次不存在'
      if (batch.status === '已放行') return '已签字放行的批次不可改写，不能再登记偏差'
      if (!state.processSteps.some((item) => item.id === intent.stepId)) return '控制点不存在'
      if (!intent.title.trim()) return '偏差标题不能为空'
      return null
    }
    case 'investigationSave': {
      const dev = state.deviations.find((item) => item.id === intent.deviationId)
      if (!dev) return '偏差不存在'
      if (dev.status === '已关闭') return '偏差已关闭，调查不可改写'
      if (!intent.investigation.cause.trim() || !intent.investigation.evidence.trim()) return '原因判断与证据摘要均不能为空'
      return null
    }
    case 'review': {
      const dev = state.deviations.find((item) => item.id === intent.deviationId)
      if (!dev) return '偏差不存在'
      if (dev.status !== '待复核') return '仅“待复核”偏差可签字复核；待重评偏差须重新提交调查'
      if (intent.approved && !intent.note.trim()) return '复核通过必须填写复核意见'
      return null
    }
    case 'batchTransition': {
      const batch = state.batches.find((item) => item.id === intent.batchId)
      if (!batch) return '批次不存在'
      if (batch.release) return '已签字放行的批次被版本冻结，状态不可改写'
      if (intent.status === '已放行') return '请使用“签字放行”完成最终签字'
      if (intent.status === '可放行' && state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭'))
        return '仍有未关闭（含待重评）偏差，禁止标记为可放行'
      return null
    }
    case 'releaseSign': {
      const batch = state.batches.find((item) => item.id === intent.batchId)
      if (!batch) return '批次不存在'
      if (batch.release) return '该批次已完成签字放行'
      if (batch.status !== '可放行') return '仅“可放行”批次可以签字'
      if (state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭'))
        return '仍有未关闭（含待重评）偏差，禁止放行'
      return null
    }
  }
}

/* ------------------------------------------------------------------ */
/* 意图应用：每个分支只在一个新版本号内完成全部联动（原子、可恢复）      */
/* ------------------------------------------------------------------ */

function applyIntent(state: HaccpState, intent: Intent, seq: number, ctx: CommitContext, now: string, notePrefix: string): { summary: string; frozenReleased: string[] } {
  switch (intent.type) {
    case 'matrixChange': return applyMatrixChange(state, intent, seq, ctx, now)
    case 'deviationCreate': return applyDeviationCreate(state, intent, seq, ctx, now)
    case 'investigationSave': return applyInvestigationSave(state, intent, seq, ctx, now, notePrefix)
    case 'review': return applyReview(state, intent, seq, ctx, now, notePrefix)
    case 'batchTransition': return applyBatchTransition(state, intent, seq, ctx, now)
    case 'releaseSign': return applyReleaseSign(state, intent, seq, ctx, now)
  }
}

function applyMatrixChange(state: HaccpState, intent: Extract<Intent, { type: 'matrixChange' }>, seq: number, ctx: CommitContext, now: string) {
  const step = state.processSteps.find((item) => item.id === intent.stepId)!
  const limitChanged = step.limit !== intent.limit
  const actionChanged = step.correctiveAction !== intent.correctiveAction
  const changedParts = [
    limitChanged ? `关键限值「${step.limit}」→「${intent.limit}」` : null,
    actionChanged ? `纠偏措施「${step.correctiveAction}」→「${intent.correctiveAction}」` : null,
    step.frequency !== intent.frequency ? `监控频率「${step.frequency}」→「${intent.frequency}」` : null
  ].filter(Boolean).join('；')

  step.limit = intent.limit
  step.frequency = intent.frequency
  step.correctiveAction = intent.correctiveAction
  step.dispositionSeq = seq

  pushAudit(state, seq, step.id, '修改控制矩阵', ctx.operator, `${step.name}：${changedParts}`, now)

  // 关键限值/纠偏措施变化：受影响的未关闭偏差冻结证据、置“待重评”，不静默改写
  const affectedDeviations = (limitChanged || actionChanged)
    ? state.deviations.filter((dev) => dev.stepId === step.id && dev.status !== '已关闭')
    : []
  const affectedBatches = new Set<string>()
  const frozenReleased: string[] = []

  for (const dev of affectedDeviations) {
    const batch = state.batches.find((item) => item.id === dev.batchId)
    // 已签字放行批次不受矩阵改写：其偏差若仍开着也不动（正常不会出现），仅登记冻结
    if (batch?.release) { frozenReleased.push(batch.id); continue }
    dev.reassessFromSeq = seq - 1
    dev.reassessReason = `V${seq}变更${limitChanged ? '关键限值' : '纠偏措施'}，原调查证据保留，须按新矩阵重新评估`
    dev.status = '待重评'
    dev.dispositionSeq = seq
    affectedBatches.add(dev.batchId)
    pushAudit(state, seq, dev.id, '偏差待重评', ctx.operator,
      `${step.name}${limitChanged ? '关键限值' : '纠偏措施'}变更；证据快照保留：原因「${dev.investigation.cause || '待调查'}」/ 证据「${dev.investigation.evidence || '待补证'}」`, now)
    if (batch) { batch.status = '隔离中'; batch.dispositionSeq = seq }
  }

  const summary = `控制矩阵变更 V${seq}：${step.name} ${changedParts}` +
    (affectedDeviations.length ? `；${affectedDeviations.length}项未关闭偏差保留证据转待重评` : '') +
    (frozenReleased.length ? `；${frozenReleased.length}个已放行批次按签字版本冻结未改写` : '')
  return { summary, frozenReleased }
}

function applyDeviationCreate(state: HaccpState, intent: Extract<Intent, { type: 'deviationCreate' }>, seq: number, ctx: CommitContext, now: string) {
  const id = `DEV-${Date.now().toString(36).toUpperCase()}-${nanoid(4)}`
  const deviation: Deviation = {
    id, batchId: intent.batchId, stepId: intent.stepId, title: intent.title, severity: intent.severity,
    status: '待调查', owner: intent.owner, openedAt: now,
    dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
    reviewNote: '', reviewer: '', version: 1, dispositionSeq: seq
  }
  state.deviations.unshift(deviation)
  const batch = state.batches.find((item) => item.id === intent.batchId)!
  batch.status = '隔离中'
  batch.dispositionSeq = seq
  pushAudit(state, seq, id, '创建偏差调查', ctx.operator, `批次${batch.id}因「${intent.title}」进入隔离，等待调查`, now)
  return { summary: `登记偏差 ${id}：${intent.title}，批次${batch.id}隔离（V${seq}）`, frozenReleased: [] }
}

function applyInvestigationSave(state: HaccpState, intent: Extract<Intent, { type: 'investigationSave' }>, seq: number, ctx: CommitContext, now: string, prefix: string) {
  const dev = state.deviations.find((item) => item.id === intent.deviationId)!
  const wasReassess = dev.status === '待重评'
  const reintroduced = wasReassess ? `（按V${seq}矩阵重新评估，原V${dev.reassessFromSeq}证据已在审计中留存）` : ''
  dev.investigation = structuredClone(intent.investigation)
  dev.status = '待复核'
  dev.reviewNote = ''
  dev.reviewer = ''
  dev.reassessFromSeq = undefined
  dev.reassessReason = undefined
  dev.dispositionSeq = seq
  const batch = state.batches.find((item) => item.id === dev.batchId)
  if (batch) batch.dispositionSeq = seq
  pushAudit(state, seq, dev.id, wasReassess ? '重评后提交调查' : '提交偏差调查', ctx.operator,
    `处置分支：${intent.investigation.decision}；证据：${intent.investigation.evidence}${reintroduced}`, now)
  return { summary: `${prefix}提交调查 ${dev.id}：${dev.title}（V${seq}）`, frozenReleased: [] }
}

function applyReview(state: HaccpState, intent: Extract<Intent, { type: 'review' }>, seq: number, ctx: CommitContext, now: string, prefix: string) {
  const dev = state.deviations.find((item) => item.id === intent.deviationId)!
  dev.reviewNote = intent.note
  dev.reviewer = ctx.operator
  dev.status = intent.approved ? '已关闭' : '调查中'
  dev.dispositionSeq = seq

  const batch = state.batches.find((item) => item.id === dev.batchId)
  if (intent.approved && batch) {
    const stillOpen = state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭' && item.id !== dev.id)
    if (!stillOpen) {
      batch.status = dev.investigation.decision === '报废' ? '已报废' : '待复核'
      batch.dispositionSeq = seq
    }
  }
  pushAudit(state, seq, dev.id, intent.approved ? '复核通过签字' : '退回补证', ctx.operator,
    intent.approved ? `复核意见：${intent.note}；偏差关闭` : (intent.note || '退回调查补证'), now)
  return { summary: `${prefix}${intent.approved ? '复核通过' : '退回补证'} ${dev.id}（V${seq}）`, frozenReleased: [] }
}

function applyBatchTransition(state: HaccpState, intent: Extract<Intent, { type: 'batchTransition' }>, seq: number, ctx: CommitContext, now: string) {
  const batch = state.batches.find((item) => item.id === intent.batchId)!
  const from = batch.status
  batch.status = intent.status
  batch.dispositionSeq = seq
  pushAudit(state, seq, batch.id, '批次状态流转', ctx.operator, `${from} → ${intent.status}（V${seq}）`, now)
  return { summary: `批次${batch.id}状态流转：${from} → ${intent.status}（V${seq}）`, frozenReleased: [] }
}

function applyReleaseSign(state: HaccpState, intent: Extract<Intent, { type: 'releaseSign' }>, seq: number, ctx: CommitContext, now: string) {
  const batch = state.batches.find((item) => item.id === intent.batchId)!
  batch.status = '已放行'
  // 签字记录冻结：后续矩阵版本不可改写批次与本签字
  batch.release = { seq, operator: ctx.operator, signedAt: now, basisSeq: seq - 1 }
  batch.dispositionSeq = seq
  pushAudit(state, seq, batch.id, '放行签字', ctx.operator,
    `批次签字放行，处置依据V${seq - 1}；此后关键限值/纠偏措施变更不再改写本批次`, now)
  return { summary: `批次${batch.id}签字放行（V${seq}），历史版本冻结`, frozenReleased: [batch.id] }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                               */
/* ------------------------------------------------------------------ */

function intentKind(intent: Intent): DispositionKind {
  return {
    matrixChange: '矩阵变更', deviationCreate: '偏差登记', investigationSave: '调查提交',
    review: '复核结论', batchTransition: '批次流转', releaseSign: '放行签字'
  }[intent.type] as DispositionKind
}

function intentSummary(intent: Intent): string {
  switch (intent.type) {
    case 'matrixChange': return `控制矩阵变更（${intent.stepId}）`
    case 'deviationCreate': return `登记偏差「${intent.title}」`
    case 'investigationSave': return `提交偏差调查 ${intent.deviationId}`
    case 'review': return `${intent.approved ? '复核通过' : '退回补证'} ${intent.deviationId}`
    case 'batchTransition': return `批次${intent.batchId}流转为${intent.status}`
    case 'releaseSign': return `批次${intent.batchId}签字放行`
  }
}

function intentBatches(intent: Intent): string[] {
  if (intent.type === 'deviationCreate' || intent.type === 'batchTransition' || intent.type === 'releaseSign') return [intent.batchId]
  if (intent.type === 'investigationSave' || intent.type === 'review') return []
  return []
}
function intentDeviations(intent: Intent): string[] {
  if (intent.type === 'investigationSave' || intent.type === 'review') return [intent.deviationId]
  return []
}
function intentSteps(intent: Intent): string[] {
  return intent.type === 'matrixChange' ? [intent.stepId] : []
}

/** 应用后按实际联动结果计算影响范围（含矩阵变更级联到的偏差/批次） */
function impactOf(intent: Intent, state: HaccpState, seq: number, frozenReleased: string[]): DispositionVersion['impact'] {
  const batches = state.batches.filter((item) => item.dispositionSeq === seq).map((item) => item.id)
  const deviations = state.deviations.filter((item) => item.dispositionSeq === seq).map((item) => item.id)
  const steps = state.processSteps.filter((item) => item.dispositionSeq === seq).map((item) => item.id)
  return { batches, deviations, steps, frozenReleased: Array.from(new Set(frozenReleased)) }
}

function pushAudit(state: HaccpState, seq: number, entity: string, action: string, operator: string, detail: string, now: string) {
  const entry: AuditEntry = { id: nanoid(), dispositionSeq: seq, entity, action, operator, detail, createdAt: now }
  state.audit.unshift(entry)
}

function pushVersion(state: HaccpState, seq: number, kind: DispositionKind, ctx: CommitContext, now: string, summary: string, impact: DispositionVersion['impact']) {
  state.versions.unshift({ seq, kind, origin: ctx.origin, operator: ctx.operator, createdAt: now, summary, impact })
}
