import { createAsyncThunk, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { buildSeedPlan } from '../data/seed'
import {
  appendOnLatest, bootstrapPlan, commitDoc, getWindowId, makeAudit, persist,
  type StorageMode
} from '../services/planSync'
import type {
  AuditEntry, Batch, BatchStatus, ConflictKind, ConflictTodo, Deviation,
  DeviationStatus, DispositionVersion, Investigation, PlanDoc, ProcessStep,
  ReleaseSignature
} from '../types'

/**
 * 在 immer draft 上下文中 structuredClone 会抛 DataCloneError（draft 是代理对象），
 * 而审计/版本链保存的都是可 JSON 化的纯数据，统一用 JSON 深拷贝。
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/* ------------------------------------------------------------------ */
/* 状态与启动加载（含旧数据迁移、写入中断恢复）                          */
/* ------------------------------------------------------------------ */

export type NoticeLevel = 'conflict' | 'error' | 'success' | 'info'

export type RetrySpec =
  | { type: 'matrix'; step: ProcessStep; operator: string }
  | { type: 'investigation'; id: string; investigation: Investigation }
  | { type: 'review'; id: string; approved: boolean; note: string; reviewer: string }
  | { type: 'reeval'; id: string; investigation: Investigation; notice: string; reviewer: string }
  | { type: 'sign'; id: string; signer: string; note: string }
  | { type: 'create'; batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }
  | { type: 'status'; id: string; status: BatchStatus; operator: string }

export interface UiNotice {
  id: string
  level: NoticeLevel
  title: string
  detail: string
  createdAt: string
  retry?: RetrySpec
}

interface HaccpState extends PlanDoc {
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  deviationStatus: DeviationStatus | '全部'
  selectedBatchId: string | null
  storageMode: StorageMode
  bootNotes: string[]
  notices: UiNotice[]
}

const boot = bootstrapPlan()

function stateFromDoc(doc: PlanDoc): HaccpState {
  return {
    ...clone(doc),
    batchFilter: '',
    batchStatus: '全部',
    deviationStatus: '全部',
    selectedBatchId: doc.batches[0]?.id ?? null,
    storageMode: boot.storageMode,
    bootNotes: boot.notes,
    notices: []
  }
}

const initialState: HaccpState = stateFromDoc(boot.doc)

/* ------------------------------------------------------------------ */
/* 纯展示状态的 reducer（过滤条件、外部窗口同步、提示条）                */
/* ------------------------------------------------------------------ */

const slice = createSlice({
  name: 'haccp',
  initialState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setDeviationStatus(state, action: PayloadAction<DeviationStatus | '全部'>) { state.deviationStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },
    hydrateDoc(state, action: PayloadAction<PlanDoc>) {
      const ui = {
        batchFilter: state.batchFilter,
        batchStatus: state.batchStatus,
        deviationStatus: state.deviationStatus,
        selectedBatchId: state.selectedBatchId,
        storageMode: state.storageMode,
        bootNotes: state.bootNotes,
        notices: state.notices
      }
      const next = stateFromDoc(action.payload)
      Object.assign(state, next, ui)
    },
    pushNotice(state, action: PayloadAction<Omit<UiNotice, 'id' | 'createdAt'>>) {
      state.notices.unshift({
        ...action.payload,
        id: nanoid(),
        createdAt: new Date().toISOString()
      })
    },
    dismissNotice(state, action: PayloadAction<string>) {
      state.notices = state.notices.filter((item) => item.id !== action.payload)
    }
  }
})

export const { setBatchFilter, setBatchStatus, setDeviationStatus, setSelectedBatch, hydrateDoc, pushNotice, dismissNotice } = slice.actions

/* ------------------------------------------------------------------ */
/* 领域辅助                                                             */
/* ------------------------------------------------------------------ */

export interface ActionResult {
  ok: boolean
  kind: 'committed' | 'conflict' | 'blocked' | 'write-failed'
  message: string
  retry?: RetrySpec
}

type SliceApi = {
  dispatch: (action: unknown) => void
  getState: () => { haccp: HaccpState }
}

function lastCompleteVersion(dispositions: DispositionVersion[]): number {
  return dispositions.reduce((max, item) => (item.status === '冲突待办' ? max : Math.max(max, item.version)), 0)
}

export function activeDisposition(deviation: Deviation): DispositionVersion | undefined {
  return [...deviation.dispositions]
    .filter((item) => item.status !== '冲突待办')
    .sort((a, b) => b.version - a.version)[0]
}

function openConflictCount(doc: PlanDoc): number {
  return doc.conflictInbox.filter((item) => item.status === '待处理').length
    + doc.deviations.reduce((sum, dev) => sum + dev.dispositions.filter((item) => item.status === '冲突待办' && !item.conflictResolved).length, 0)
}

function isBatchSigned(doc: PlanDoc, batchId: string): boolean {
  return doc.signatures.some((item) => item.batchId === batchId)
}

function blockingDeviations(doc: PlanDoc, batchId: string): Deviation[] {
  return doc.deviations.filter((item) => item.batchId === batchId && (item.status !== '已关闭' || item.pendingReeval))
}

function snapshotDeviationVersions(doc: PlanDoc, batchId: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const dev of doc.deviations.filter((item) => item.batchId === batchId)) {
    result[dev.id] = lastCompleteVersion(dev.dispositions)
  }
  return result
}

function findDeviation(doc: PlanDoc, id: string) {
  return doc.deviations.find((item) => item.id === id)
}

function newConflictId(): string {
  return `CFL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function pushInboxConflict(
  draft: PlanDoc,
  spec: {
    kind: ConflictKind
    entity: string
    batchId: string
    deviationId?: string
    stepId?: string
    dispositionVersion?: number
    operator: string
    summary: string
    payload: unknown
  }
): ConflictTodo {
  const item: ConflictTodo = {
    id: newConflictId(),
    kind: spec.kind,
    entity: spec.entity,
    batchId: spec.batchId,
    stepId: spec.stepId,
    deviationId: spec.deviationId,
    dispositionVersion: spec.dispositionVersion,
    windowId: getWindowId(),
    operator: spec.operator,
    summary: spec.summary,
    payload: spec.payload,
    createdAt: new Date().toISOString(),
    status: '待处理'
  }
  draft.conflictInbox.unshift(item)
  return item
}

/** CAS 循环：自动重放无关变更导致的过期；同处置版本竞争则登记冲突待办。 */
async function casCommit(
  api: SliceApi,
  options: {
    retry: RetrySpec
    build: (base: PlanDoc) => { ok: true; apply: (draft: PlanDoc) => void; success: string } | { ok: false; message: string }
    detectConflict: (latest: PlanDoc, originalBase: PlanDoc) => boolean
    appendConflict: (draft: PlanDoc, latest: PlanDoc, originalBase: PlanDoc) => void
    conflictTitle: string
    conflictDetail: (latest: PlanDoc) => string
  }
): Promise<ActionResult> {
  // 本窗口打开时看到的基线版本；stale 后 hydrate 只用于刷新展示，判定冲突仍以此基线为准。
  const originalBase = requireLatest()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const base = requireLatest()
    const built = options.build(base)
    if (!built.ok) return { ok: false, kind: 'blocked', message: built.message }
    const result = commitDoc(base.planVersion, built.apply)
    if (result.kind === 'committed') {
      api.dispatch(hydrateDoc(result.doc))
      return { ok: true, kind: 'committed', message: built.success }
    }
    if (result.kind === 'write-failed') {
      api.dispatch(pushNotice({
        level: 'error',
        title: '写入失败，已保留上一完整版本',
        detail: `${result.error}。审计未产生半套记录，可点“重试”接着最后一个完整版本继续。`,
        retry: options.retry
      }))
      return { ok: false, kind: 'write-failed', message: '写入失败：' + result.error, retry: options.retry }
    }
    // stale：先把其它窗口已提交的完整版本同步进来，再决定是冲突还是重放。
    api.dispatch(hydrateDoc(result.current))
    if (options.detectConflict(result.current, originalBase)) {
      const appendResult = appendOnLatest((draft) => options.appendConflict(draft, result.current, originalBase))
      if (appendResult.kind === 'committed') {
        api.dispatch(hydrateDoc(appendResult.doc))
        api.dispatch(pushNotice({
          level: 'conflict',
          title: options.conflictTitle,
          detail: options.conflictDetail(appendResult.doc),
          retry: undefined
        }))
        return { ok: false, kind: 'conflict', message: options.conflictDetail(appendResult.doc) }
      }
      api.dispatch(pushNotice({
        level: 'error',
        title: '冲突待办写入失败',
        detail: '存储暂时不可用，本次提交未覆盖任何数据，可稍后重试。',
        retry: options.retry
      }))
      return { ok: false, kind: 'write-failed', message: '冲突登记失败', retry: options.retry }
    }
    // 只是其它实体先提交了一个版本，下一轮自动基于最新版重放本次提交。
  }
  return { ok: false, kind: 'write-failed', message: '版本竞争重试多次仍未成功，请刷新后基于最新版本重试。', retry: options.retry }

  function requireLatest(): PlanDoc {
    const state = api.getState().haccp
    return {
      planVersion: state.planVersion,
      processSteps: state.processSteps,
      batches: state.batches,
      deviations: state.deviations,
      signatures: state.signatures,
      conflictInbox: state.conflictInbox,
      audit: state.audit
    }
  }
}

/* ------------------------------------------------------------------ */
/* 控制矩阵改版：关键限值/纠偏措施变化 → 未关闭偏差等待重评             */
/* ------------------------------------------------------------------ */

export interface StepChangeArg {
  step: ProcessStep
  operator: string
}

export const updateProcessStep = createAsyncThunk<ActionResult, StepChangeArg>(
  'haccp/updateProcessStep',
  async (arg, rawApi) => {
    const api = rawApi as unknown as SliceApi
    return casCommit(api, {
      retry: { type: 'matrix', step: arg.step, operator: arg.operator },
      build: (base) => {
        const previous = base.processSteps.find((item) => item.id === arg.step.id)
        if (!previous) return { ok: false, message: '控制点不存在' }
        if (!arg.step.limit.trim() || !arg.step.correctiveAction.trim()) {
          return { ok: false, message: '关键限值和纠偏措施不得为空' }
        }
        const limitChanged = previous.limit !== arg.step.limit
        const actionChanged = previous.correctiveAction !== arg.step.correctiveAction
        const criticalChanged = limitChanged || actionChanged
        return {
          ok: true as const,
          success: `控制矩阵V${base.planVersion + 1}已保存`,
          apply: (draft) => {
            const index = draft.processSteps.findIndex((item) => item.id === arg.step.id)
            draft.processSteps[index] = clone(arg.step)
            const newPlanVersion = draft.planVersion
            const affected: string[] = []
            if (criticalChanged) {
              for (const deviation of draft.deviations) {
                if (deviation.stepId !== arg.step.id || deviation.status === '已关闭') continue
                const batch = draft.batches.find((item) => item.id === deviation.batchId)
                // 已完成签字放行的批次不被改写。
                if (!batch || isBatchSigned(draft, deviation.batchId)) continue
                const source = activeDisposition(deviation)
                const hold: DispositionVersion = {
                  version: lastCompleteVersion(deviation.dispositions) + 1,
                  kind: '重评',
                  status: '等待重评',
                  operator: '系统（控制矩阵改版）',
                  note: `矩阵V${newPlanVersion}${limitChanged ? `将关键限值由「${previous.limit}」改为「${arg.step.limit}」` : ''}${limitChanged && actionChanged ? '，并' : ''}${actionChanged ? `将纠偏措施改为「${arg.step.correctiveAction}」` : ''}。证据保留，等待质量负责人重评。`,
                  investigation: clone(source?.investigation ?? deviation.investigation),
                  reviewNote: source?.reviewNote ?? deviation.reviewNote ?? '',
                  reviewer: source?.reviewer ?? deviation.reviewer ?? '',
                  basedOnPlanVersion: base.planVersion,
                  reevalRequiredByPlan: newPlanVersion,
                  impactScope: deviation.impactScope,
                  evidenceRef: source?.evidenceRef ?? '',
                  createdAt: new Date().toISOString()
                }
                deviation.dispositions.push(hold)
                deviation.version = hold.version
                deviation.pendingReeval = true
                deviation.reevalReason = `控制矩阵V${newPlanVersion}关键限值/纠偏措施变化，需重评`
                deviation.status = '调查中'
                batch.status = '隔离中'
                batch.version += 1
                affected.push(`${deviation.id}（${deviation.impactScope}）`)
                draft.audit.unshift(makeAudit(
                  deviation.id, '处置版本等待重评', '系统',
                  `关键限值/纠偏措施随矩阵V${newPlanVersion}变化，既有证据与处置V${hold.version - 1}保留，新增处置版本V${hold.version}等待重评；批次${batch.id}维持隔离`,
                  newPlanVersion, { dispositionVersion: hold.version }
                ))
              }
            }
            draft.audit.unshift(makeAudit(
              arg.step.id, '控制矩阵改版', arg.operator,
              `${previous.name}：${limitChanged ? `关键限值「${previous.limit}」→「${arg.step.limit}」` : ''}${limitChanged && actionChanged ? '；' : ''}${actionChanged ? `纠偏措施更新为「${arg.step.correctiveAction}」` : ''}${previous.frequency !== arg.step.frequency ? `；监控频率「${previous.frequency}」→「${arg.step.frequency}」` : ''}。影响范围：${criticalChanged ? (affected.length ? affected.join('；') : '无未关闭偏差，已放行批次未改写') : '仅监控频率变化，不触发重评'}`,
              newPlanVersion
            ))
          }
        }
      },
      detectConflict: (latest, originalBase) => {
        // 仅当最新文档里的该控制点已偏离本窗口提交时的基线（被对方改过）才算矩阵并发。
        const baseStep = originalBase.processSteps.find((item) => item.id === arg.step.id)
        const latestStep = latest.processSteps.find((item) => item.id === arg.step.id)
        if (!baseStep || !latestStep) return false
        return latestStep.limit !== baseStep.limit
          || latestStep.correctiveAction !== baseStep.correctiveAction
          || latestStep.frequency !== baseStep.frequency
      },
      appendConflict: (draft) => {
        const incoming = pushInboxConflict(draft, {
          kind: '矩阵改版',
          entity: arg.step.id,
          batchId: '-',
          stepId: arg.step.id,
          operator: arg.operator,
          summary: `${arg.step.name}控制矩阵被两个窗口同时修改`,
          payload: arg.step
        })
        draft.audit.unshift(makeAudit(
          arg.step.id, '冲突待办', arg.operator,
          `另一窗口已先提交${arg.step.name}的矩阵改版（文档V${draft.planVersion}）；本窗口版本进入冲突待办${incoming.id}，未覆盖对方数据`,
          draft.planVersion, { conflict: true }
        ))
      },
      conflictTitle: '矩阵改版冲突，已进入冲突待办',
      conflictDetail: (latest) => `另一窗口已先提交${arg.step.name}的控制矩阵（当前文档V${latest.planVersion}）。你的修改已原样保留在冲突待办，可在偏差工作台“重放（基于最新版再提交）”或“留档”，不会覆盖对方版本。`
    })
  }
)

/** 保存前预览受影响的未关闭偏差与影响范围（编辑面板使用）。 */
export function previewMatrixImpact(doc: PlanDoc, stepId: string): Array<{ deviation: Deviation; batch: Batch | undefined; signed: boolean }> {
  return doc.deviations
    .filter((deviation) => deviation.stepId === stepId && deviation.status !== '已关闭')
    .map((deviation) => ({
      deviation,
      batch: doc.batches.find((item) => item.id === deviation.batchId),
      signed: isBatchSigned(doc, deviation.batchId)
    }))
}

/* ------------------------------------------------------------------ */
/* 偏差调查提交（同一处置版本并发 → 冲突待办，证据原样保留）             */
/* ------------------------------------------------------------------ */

export const saveInvestigation = createAsyncThunk<ActionResult, { id: string; investigation: Investigation; operator?: string }>(
  'haccp/saveInvestigation',
  async ({ id, investigation, operator }, rawApi) => {
    const api = rawApi as unknown as SliceApi
    const op = operator ?? '质量工程组'
    return casCommit(api, {
      retry: { type: 'investigation', id, investigation },
      build: (base) => {
        const deviation = findDeviation(base, id)
        if (!deviation) return { ok: false, message: '偏差不存在' }
        if (deviation.status === '已关闭') return { ok: false, message: '偏差已关闭，处置版本不可改写' }
        if (deviation.pendingReeval) return { ok: false, message: '该偏差正等待矩阵改版重评，请使用“重评确认”而不是重新提交调查' }
        if (!investigation.cause.trim() || !investigation.evidence.trim()) {
          return { ok: false, message: '原因判断和证据摘要不得为空' }
        }
        const nextVersion = lastCompleteVersion(deviation.dispositions) + 1
        return {
          ok: true as const,
          success: `${id}处置版本V${nextVersion}已提交`,
          apply: (draft) => {
            const dev = findDeviation(draft, id)!
            const version: DispositionVersion = {
              version: nextVersion,
              kind: '调查',
              status: '待复核',
              operator: op,
              note: `提交调查：${investigation.cause}`,
              investigation: clone(investigation),
              reviewNote: '',
              reviewer: '',
              basedOnPlanVersion: draft.planVersion - 1,
              impactScope: dev.impactScope,
              evidenceRef: investigation.evidence,
              createdAt: new Date().toISOString()
            }
            dev.dispositions.push(version)
            dev.version = nextVersion
            dev.investigation = clone(investigation)
            dev.status = '待复核'
            draft.audit.unshift(makeAudit(
              id, '提交偏差调查', op,
              `处置分支：${investigation.decision}；新增处置版本V${nextVersion}（文档V${draft.planVersion}），证据：${investigation.evidence}`,
              draft.planVersion, { dispositionVersion: nextVersion }
            ))
          }
        }
      },
      detectConflict: (latest, originalBase) => {
        const deviation = findDeviation(latest, id)
        const baseDev = findDeviation(originalBase, id)
        if (!deviation || !baseDev) return false
        const incomingVersion = lastCompleteVersion(baseDev.dispositions) + 1
        return lastCompleteVersion(deviation.dispositions) >= incomingVersion
      },
      appendConflict: (draft, _latest, originalBase) => {
        const dev = findDeviation(draft, id)!
        const baseDev = findDeviation(originalBase, id)!
        const conflictVersion = lastCompleteVersion(baseDev.dispositions) + 1
        const winner = dev.dispositions.filter((item) => item.status !== '冲突待办' && item.version === conflictVersion)[0]
        dev.dispositions.push({
          version: conflictVersion,
          kind: '调查',
          status: '冲突待办',
          operator: op,
          note: `与处置版本V${conflictVersion}并发提交，进入冲突待办；本窗口证据原样保留`,
          investigation: clone(investigation),
          reviewNote: '',
          reviewer: '',
          basedOnPlanVersion: draft.planVersion - 1,
          impactScope: dev.impactScope,
          evidenceRef: investigation.evidence,
          createdAt: new Date().toISOString(),
          conflictsWithVersion: conflictVersion,
          conflictKind: '调查提交',
          conflictWindowId: getWindowId(),
          conflictPayload: clone(investigation)
        })
        dev.version = conflictVersion
        const inbox = pushInboxConflict(draft, {
          kind: '调查提交',
          entity: id,
          batchId: dev.batchId,
          deviationId: id,
          dispositionVersion: conflictVersion,
          operator: op,
          summary: `${id} 调查提交并发冲突（处置V${conflictVersion}）`,
          payload: investigation
        })
        draft.audit.unshift(makeAudit(
          id, '冲突待办', op,
          `两窗口同时提交${id}的处置版本V${conflictVersion}：对方提交人${winner?.operator ?? '未知'}已生效，本窗口证据保留为冲突待办${inbox.id}，未覆盖对方证据`,
          draft.planVersion, { dispositionVersion: conflictVersion, conflict: true }
        ))
      },
      conflictTitle: '同一处置版本并发，后到一方已进入冲突待办',
      conflictDetail: (latest) => `${id}的处置版本已有他方先提交（文档V${latest.planVersion}）。你的调查与证据未被覆盖，已保留为冲突待办，可“重放（按最新版生成新版本）”或“留档”。`
    })
  }
)

/* ------------------------------------------------------------------ */
/* 复核签字 / 退回补证                                                  */
/* ------------------------------------------------------------------ */

export interface ReviewArg {
  id: string
  approved: boolean
  note: string
  reviewer: string
}

export const reviewDeviation = createAsyncThunk<ActionResult, ReviewArg>(
  'haccp/reviewDeviation',
  async (arg, rawApi) => {
    const api = rawApi as unknown as SliceApi
    return casCommit(api, {
      retry: { type: 'review', ...arg },
      build: (base) => {
        const deviation = findDeviation(base, arg.id)
        if (!deviation) return { ok: false, message: '偏差不存在' }
        if (deviation.status === '已关闭') return { ok: false, message: '偏差已关闭，不能重复签字' }
        if (deviation.pendingReeval) return { ok: false, message: '矩阵改版后该偏差等待重评，请先完成重评确认再复核签字' }
        if (arg.approved && !arg.note.trim()) return { ok: false, message: '复核通过必须填写签字意见' }
        const nextVersion = lastCompleteVersion(deviation.dispositions) + 1
        return {
          ok: true as const,
          success: `${arg.id}复核${arg.approved ? '通过' : '退回'}（处置V${nextVersion}）`,
          apply: (draft) => {
            const dev = findDeviation(draft, arg.id)!
            const version: DispositionVersion = {
              version: nextVersion,
              kind: '复核',
              status: arg.approved ? '已完成' : '进行中',
              operator: arg.reviewer,
              note: arg.approved ? `复核通过：${arg.note}` : `退回补证：${arg.note || '退回调查'}`,
              investigation: clone(dev.investigation),
              reviewNote: arg.note,
              reviewer: arg.reviewer,
              basedOnPlanVersion: draft.planVersion - 1,
              impactScope: dev.impactScope,
              evidenceRef: activeDisposition(dev)?.evidenceRef ?? '',
              createdAt: new Date().toISOString()
            }
            dev.dispositions.push(version)
            dev.version = nextVersion
            dev.reviewNote = arg.note
            dev.reviewer = arg.reviewer
            dev.status = arg.approved ? '已关闭' : '调查中'
            if (arg.approved) {
              const batch = draft.batches.find((item) => item.id === dev.batchId)
              if (batch && blockingDeviations(draft, batch.id).length === 0) {
                batch.status = dev.investigation.decision === '报废' ? '已报废' : '待复核'
                batch.version += 1
              }
            }
            draft.audit.unshift(makeAudit(
              arg.id, arg.approved ? '复核通过' : '退回补证', arg.reviewer,
              `${arg.approved ? '复核签字通过' : '退回补充证据'}，处置版本V${nextVersion}（文档V${draft.planVersion}）：${arg.note || '退回调查'}`,
              draft.planVersion, { dispositionVersion: nextVersion }
            ))
          }
        }
      },
      detectConflict: (latest, originalBase) => {
        const deviation = findDeviation(latest, arg.id)
        const baseDev = findDeviation(originalBase, arg.id)
        if (!deviation || !baseDev) return false
        const incomingVersion = lastCompleteVersion(baseDev.dispositions) + 1
        return deviation.status === '已关闭' || lastCompleteVersion(deviation.dispositions) >= incomingVersion
      },
      appendConflict: (draft, _latest, originalBase) => {
        const dev = findDeviation(draft, arg.id)!
        const baseDev = findDeviation(originalBase, arg.id)!
        const conflictVersion = lastCompleteVersion(baseDev.dispositions) + 1
        dev.dispositions.push({
          version: conflictVersion,
          kind: '复核',
          status: '冲突待办',
          operator: arg.reviewer,
          note: `与处置版本V${conflictVersion}并发复核，进入冲突待办`,
          investigation: clone(dev.investigation),
          reviewNote: arg.note,
          reviewer: arg.reviewer,
          basedOnPlanVersion: draft.planVersion - 1,
          impactScope: dev.impactScope,
          evidenceRef: activeDisposition(dev)?.evidenceRef ?? '',
          createdAt: new Date().toISOString(),
          conflictsWithVersion: conflictVersion,
          conflictKind: '复核签字',
          conflictWindowId: getWindowId(),
          conflictPayload: { approved: arg.approved, note: arg.note }
        })
        const inbox = pushInboxConflict(draft, {
          kind: '复核签字',
          entity: arg.id,
          batchId: dev.batchId,
          deviationId: arg.id,
          dispositionVersion: conflictVersion,
          operator: arg.reviewer,
          summary: `${arg.id} 复核签字并发冲突（处置V${conflictVersion}）`,
          payload: { approved: arg.approved, note: arg.note }
        })
        draft.audit.unshift(makeAudit(
          arg.id, '冲突待办', arg.reviewer,
          `两窗口同时提交${arg.id}处置版本V${conflictVersion}的复核，先到一方签字已生效；本窗口签字保留为冲突待办${inbox.id}，未覆盖对方签字`,
          draft.planVersion, { dispositionVersion: conflictVersion, conflict: true }
        ))
      },
      conflictTitle: '复核签字并发，后到一方已进入冲突待办',
      conflictDetail: (latest) => `${arg.id}的复核签字已被另一窗口抢先提交（文档V${latest.planVersion}）。你的签字没有覆盖对方，已保留为冲突待办，可重放或留档。`
    })
  }
)

/* ------------------------------------------------------------------ */
/* 矩阵改版后的重评确认                                                  */
/* ------------------------------------------------------------------ */

export interface ReevalArg {
  id: string
  investigation: Investigation
  note: string
  reviewer: string
}

export const reevaluateDeviation = createAsyncThunk<ActionResult, ReevalArg>(
  'haccp/reevaluateDeviation',
  async (arg, rawApi) => {
    const api = rawApi as unknown as SliceApi
    return casCommit(api, {
      retry: { type: 'reeval', id: arg.id, investigation: arg.investigation, notice: arg.note, reviewer: arg.reviewer },
      build: (base) => {
        const deviation = findDeviation(base, arg.id)
        if (!deviation) return { ok: false, message: '偏差不存在' }
        if (!deviation.pendingReeval) return { ok: false, message: '该偏差当前不需要重评' }
        if (!arg.note.trim()) return { ok: false, message: '重评结论不得为空' }
        const nextVersion = lastCompleteVersion(deviation.dispositions) + 1
        return {
          ok: true as const,
          success: `${arg.id}重评完成（处置V${nextVersion}），进入复核`,
          apply: (draft) => {
            const dev = findDeviation(draft, arg.id)!
            const version: DispositionVersion = {
              version: nextVersion,
              kind: '重评',
              status: '待复核',
              operator: arg.reviewer,
              note: `重评确认：${arg.note}`,
              investigation: clone(arg.investigation),
              reviewNote: '',
              reviewer: '',
              basedOnPlanVersion: draft.planVersion - 1,
              reevalRequiredByPlan: activeDisposition(dev)?.reevalRequiredByPlan,
              impactScope: dev.impactScope,
              evidenceRef: `${activeDisposition(dev)?.evidenceRef ?? ''}；重评补充：${arg.investigation.evidence || '沿用原证据'}`.trim(),
              createdAt: new Date().toISOString()
            }
            dev.dispositions.push(version)
            dev.version = nextVersion
            dev.investigation = clone(arg.investigation)
            dev.pendingReeval = false
            dev.reevalReason = ''
            dev.status = '待复核'
            draft.audit.unshift(makeAudit(
              arg.id, '重评确认', arg.reviewer,
              `矩阵改版重评完成，新增处置版本V${nextVersion}（文档V${draft.planVersion}），历史证据保留：${arg.note}`,
              draft.planVersion, { dispositionVersion: nextVersion }
            ))
          }
        }
      },
      detectConflict: (latest, originalBase) => {
        const deviation = findDeviation(latest, arg.id)
        const baseDev = findDeviation(originalBase, arg.id)
        if (!deviation || !baseDev) return false
        return !deviation.pendingReeval
          || lastCompleteVersion(deviation.dispositions) > lastCompleteVersion(baseDev.dispositions)
      },
      appendConflict: (draft, _latest, originalBase) => {
        const dev = findDeviation(draft, arg.id)!
        const baseDev = findDeviation(originalBase, arg.id)!
        const conflictVersion = lastCompleteVersion(baseDev.dispositions) + 1
        dev.dispositions.push({
          version: conflictVersion,
          kind: '重评',
          status: '冲突待办',
          operator: arg.reviewer,
          note: '重评与其它窗口并发提交，进入冲突待办',
          investigation: clone(arg.investigation),
          reviewNote: '',
          reviewer: '',
          basedOnPlanVersion: draft.planVersion - 1,
          impactScope: dev.impactScope,
          evidenceRef: arg.investigation.evidence,
          createdAt: new Date().toISOString(),
          conflictsWithVersion: conflictVersion,
          conflictKind: '重评',
          conflictWindowId: getWindowId(),
          conflictPayload: clone({ id: arg.id, investigation: arg.investigation, notice: arg.note, reviewer: arg.reviewer })
        })
        const inbox = pushInboxConflict(draft, {
          kind: '重评',
          entity: arg.id,
          batchId: dev.batchId,
          deviationId: arg.id,
          dispositionVersion: conflictVersion,
          operator: arg.reviewer,
          summary: `${arg.id} 重评并发冲突（处置V${conflictVersion}）`,
          payload: arg
        })
        draft.audit.unshift(makeAudit(
          arg.id, '冲突待办', arg.reviewer,
          `两窗口同时提交${arg.id}的重评（处置V${conflictVersion}），后到一方进入冲突待办${inbox.id}，未覆盖对方结论`,
          draft.planVersion, { dispositionVersion: conflictVersion, conflict: true }
        ))
      },
      conflictTitle: '重评并发，已进入冲突待办',
      conflictDetail: (latest) => `${arg.id}的重评已被另一窗口先处理（文档V${latest.planVersion}），你的结论已保留为冲突待办。`
    })
  }
)

/* ------------------------------------------------------------------ */
/* 批次状态流转与签字放行（签字原子生效，已签字批次冻结）               */
/* ------------------------------------------------------------------ */

export const updateBatchStatus = createAsyncThunk<ActionResult, { id: string; status: BatchStatus; operator?: string }>(
  'haccp/updateBatchStatus',
  async ({ id, status, operator }, rawApi) => {
    const api = rawApi as unknown as SliceApi
    const op = operator ?? '质量主管'
    return casCommit(api, {
      retry: { type: 'status', id, status, operator: op },
      build: (base) => {
        const batch = base.batches.find((item) => item.id === id)
        if (!batch) return { ok: false, message: '批次不存在' }
        if (isBatchSigned(base, id)) return { ok: false, message: '批次已完成签字放行，状态不可改写' }
        if (status === '可放行' && blockingDeviations(base, id).length > 0) {
          return { ok: false, message: `批次${id}仍有未关闭或等待重评的偏差，不能提交放行复核` }
        }
        return {
          ok: true as const,
          success: `${id}状态更新为${status}`,
          apply: (draft) => {
            const target = draft.batches.find((item) => item.id === id)!
            target.status = status
            target.version += 1
            draft.audit.unshift(makeAudit(id, '批次状态流转', op, `状态更新为${status}（文档V${draft.planVersion}）`, draft.planVersion))
          }
        }
      },
      detectConflict: (latest, originalBase) => {
        const current = latest.batches.find((item) => item.id === id)
        const base = originalBase.batches.find((item) => item.id === id)
        return !!current && !!base && current.status !== base.status
      },
      appendConflict: (draft) => {
        draft.audit.unshift(makeAudit(id, '批次流转冲突', op, `批次${id}状态已被其它窗口更新，本窗口提交未覆盖（文档V${draft.planVersion}）`, draft.planVersion, { conflict: true }))
      },
      conflictTitle: '批次状态已被其它窗口更新',
      conflictDetail: (latest) => `${id}当前为${latest.batches.find((item) => item.id === id)?.status ?? '未知'}，请基于最新版本操作。`
    })
  }
)

export interface SignArg {
  id: string
  signer: string
  note: string
}

export const signBatchRelease = createAsyncThunk<ActionResult, SignArg>(
  'haccp/signBatchRelease',
  async (arg, rawApi) => {
    const api = rawApi as unknown as SliceApi
    return casCommit(api, {
      retry: { type: 'sign', ...arg },
      build: (base) => {
        const batch = base.batches.find((item) => item.id === arg.id)
        if (!batch) return { ok: false, message: '批次不存在' }
        if (isBatchSigned(base, arg.id)) return { ok: false, message: '该批次已完成签字放行，签字不可重复或改写' }
        const blockers = blockingDeviations(base, arg.id)
        if (blockers.length > 0) return { ok: false, message: `仍有${blockers.length}项未关闭/等待重评偏差，不能签字放行` }
        if (batch.status !== '可放行') return { ok: false, message: '批次尚未通过放行复核，不能签字' }
        if (!arg.note.trim()) return { ok: false, message: '放行签字意见不得为空' }
        const versions = snapshotDeviationVersions(base, arg.id)
        return {
          ok: true as const,
          success: `${arg.id}签字放行完成（矩阵V${base.planVersion}）`,
          apply: (draft) => {
            const target = draft.batches.find((item) => item.id === arg.id)!
            const signature: ReleaseSignature = {
              batchId: arg.id,
              signer: arg.signer,
              note: arg.note,
              dispositionVersions: snapshotDeviationVersions(draft, arg.id),
              planVersion: draft.planVersion - 1,
              signedAt: new Date().toISOString()
            }
            draft.signatures.push(signature)
            target.status = '已放行'
            target.version += 1
            draft.audit.unshift(makeAudit(
              arg.id, '签字放行', arg.signer,
              `批次签字放行（文档V${draft.planVersion}）；锁定处置版本${Object.entries(versions).map(([dev, ver]) => `${dev}=V${ver}`).join('，') || '无关联偏差'}；签字后批次冻结，矩阵改版不再改写`,
              draft.planVersion
            ))
          }
        }
      },
      detectConflict: (latest) => isBatchSigned(latest, arg.id),
      appendConflict: (draft) => {
        const incoming = pushInboxConflict(draft, {
          kind: '放行签字',
          entity: arg.id,
          batchId: arg.id,
          operator: arg.signer,
          summary: `${arg.id} 放行签字并发冲突`,
          payload: { signer: arg.signer, note: arg.note }
        })
        draft.audit.unshift(makeAudit(
          arg.id, '冲突待办', arg.signer,
          `两窗口同时对${arg.id}签字放行，先到一方签字已生效并锁定批次；后到签字保留为冲突待办${incoming.id}，未覆盖对方签字`,
          draft.planVersion, { conflict: true }
        ))
      },
      conflictTitle: '放行签字并发，后到签字已进入冲突待办',
      conflictDetail: (latest) => `${arg.id}已由另一窗口完成签字放行（文档V${latest.planVersion}）并冻结。你的签字未覆盖对方，已保留为冲突待办，可留档备查。`
    })
  }
)

/* ------------------------------------------------------------------ */
/* 偏差登记                                                              */
/* ------------------------------------------------------------------ */

export const createDeviation = createAsyncThunk<
  ActionResult,
  { batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }
>('haccp/createDeviation', async (arg, rawApi) => {
  const api = rawApi as unknown as SliceApi
  return casCommit(api, {
    retry: { type: 'create', ...arg },
    build: (base) => {
      const batch = base.batches.find((item) => item.id === arg.batchId)
      if (!batch) return { ok: false, message: '批次不存在' }
      if (isBatchSigned(base, arg.batchId)) return { ok: false, message: '批次已签字放行，不能再登记偏差' }
      if (!arg.title.trim()) return { ok: false, message: '偏差标题不得为空' }
      const id = `DEV-${Date.now().toString().slice(-8)}`
      const now = new Date().toISOString()
      return {
        ok: true as const,
        success: `已登记偏差${id}并隔离批次`,
        apply: (draft) => {
          const target = draft.batches.find((item) => item.id === arg.batchId)!
          const impactScope = target.isolationScope && target.isolationScope !== '无'
            ? `${target.isolationScope}（${arg.batchId}，${target.quantity}件）`
            : `控制点${arg.stepId}关联批次${arg.batchId}（${target.quantity}件）`
          const deviation: Deviation = {
            id,
            batchId: arg.batchId,
            stepId: arg.stepId,
            title: arg.title,
            severity: arg.severity,
            status: '待调查',
            owner: arg.owner,
            openedAt: now,
            dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
            reviewNote: '',
            reviewer: '',
            version: 1,
            impactScope,
            pendingReeval: false,
            reevalReason: '',
            dispositions: [{
              version: 1,
              kind: '登记',
              status: '已完成',
              operator: arg.owner,
              note: `登记偏差：${arg.title}`,
              investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
              reviewNote: '',
              reviewer: '',
              basedOnPlanVersion: draft.planVersion - 1,
              impactScope,
              evidenceRef: '',
              createdAt: now
            }]
          }
          draft.deviations.unshift(deviation)
          target.status = '隔离中'
          target.version += 1
          draft.audit.unshift(makeAudit(
            id, '创建偏差调查', arg.owner,
            `批次${arg.batchId}因${arg.title}进入隔离；影响范围：${impactScope}；处置版本V1（文档V${draft.planVersion}）`,
            draft.planVersion, { dispositionVersion: 1 }
          ))
        }
      }
    },
    detectConflict: () => false,
    appendConflict: () => { /* 登记不产生同版本竞争，冲突由重放兜底 */ },
    conflictTitle: '',
    conflictDetail: () => ''
  })
})

/* ------------------------------------------------------------------ */
/* 冲突待办处理：重放（基于最新版再提交）/ 留档                          */
/* ------------------------------------------------------------------ */

export const resolveConflict = createAsyncThunk<
  ActionResult,
  { inboxId?: string; deviationId?: string; dispositionVersion?: number; resolution: 'replay' | 'archive'; operator: string; note?: string }
>('haccp/resolveConflict', async (arg, rawApi) => {
  const api = rawApi as unknown as SliceApi
  const result = appendOnLatest((draft) => {
    const inbox = draft.conflictInbox.find((item) => item.id === arg.inboxId)
    let kind: ConflictKind | undefined = inbox?.kind
    let deviationId = arg.deviationId ?? inbox?.deviationId
    let version = arg.dispositionVersion ?? inbox?.dispositionVersion
    let conflictRecord: DispositionVersion | undefined
    if (deviationId && version) {
      const dev = draft.deviations.find((item) => item.id === deviationId)
      conflictRecord = dev?.dispositions.find((item) => item.version === version && item.status === '冲突待办' && !item.conflictResolved)
      if (!kind) kind = conflictRecord?.conflictKind
    }
    const resolvedAt = new Date().toISOString()
    const mark = (success: boolean, detail: string) => {
      if (inbox) {
        inbox.status = success ? '已重放' : '已留档'
        inbox.resolvedAt = resolvedAt
        inbox.resolvedBy = arg.operator
        inbox.resolutionNote = arg.note ?? detail
      }
      if (conflictRecord) {
        conflictRecord.conflictResolved = true
        conflictRecord.resolvedAt = resolvedAt
        conflictRecord.resolvedBy = arg.operator
        conflictRecord.resolution = success ? '已重放' : '已留档'
      }
      draft.audit.unshift(makeAudit(inbox?.entity ?? deviationId ?? '冲突待办', success ? '冲突重放' : '冲突留档', arg.operator, detail, draft.planVersion, { dispositionVersion: version, conflict: false }))
    }

    if (arg.resolution === 'archive') {
      mark(false, `冲突待办${inbox?.id ?? ''}留档备查，未改写任何已生效版本`)
      return
    }

    if (kind === '调查提交' && deviationId) {
      const dev = draft.deviations.find((item) => item.id === deviationId)
      const investigation = (inbox?.payload ?? conflictRecord?.conflictPayload) as Investigation | undefined
      if (!dev || !investigation || dev.status === '已关闭' || isBatchSigned(draft, dev.batchId)) {
        mark(false, '重放条件已不满足（偏差关闭或批次已签字），自动转为留档')
        return
      }
      const nextVersion = lastCompleteVersion(dev.dispositions) + 1
      dev.dispositions.push({
        version: nextVersion, kind: '调查', status: '待复核', operator: inbox?.operator ?? arg.operator,
        note: `冲突重放：基于最新文档V${draft.planVersion}重新提交调查`, investigation: clone(investigation),
        reviewNote: '', reviewer: '', basedOnPlanVersion: draft.planVersion - 1, impactScope: dev.impactScope,
        evidenceRef: investigation.evidence, createdAt: new Date().toISOString()
      })
      dev.version = nextVersion
      dev.investigation = clone(investigation)
      dev.status = '待复核'
      mark(true, `冲突重放：调查内容基于最新文档生成${deviationId}处置版本V${nextVersion}，原冲突证据保留`)
      return
    }

    if ((kind === '复核签字' || kind === '重评') && deviationId) {
      const dev = draft.deviations.find((item) => item.id === deviationId)
      if (!dev || dev.status === '已关闭' || isBatchSigned(draft, dev.batchId)) {
        mark(false, '重放条件已不满足（偏差关闭或批次已签字），自动转为留档')
        return
      }
      if (kind === '重评') {
        const payload = (inbox?.payload ?? conflictRecord?.conflictPayload) as { investigation: Investigation; notice: string; reviewer: string } | undefined
        if (!payload || !dev.pendingReeval) {
          mark(false, '重评重放条件已不满足，自动转为留档')
          return
        }
        const nextVersion = lastCompleteVersion(dev.dispositions) + 1
        dev.dispositions.push({
          version: nextVersion, kind: '重评', status: '待复核', operator: payload.reviewer,
          note: `冲突重放：${payload.notice}`, investigation: clone(payload.investigation),
          reviewNote: '', reviewer: '', basedOnPlanVersion: draft.planVersion - 1, impactScope: dev.impactScope,
          evidenceRef: payload.investigation.evidence, createdAt: new Date().toISOString()
        })
        dev.version = nextVersion
        dev.investigation = clone(payload.investigation)
        dev.pendingReeval = false
        dev.reevalReason = ''
        dev.status = '待复核'
        mark(true, `冲突重放：重评结论生成${deviationId}处置版本V${nextVersion}`)
        return
      }
      const payload = (inbox?.payload ?? conflictRecord?.conflictPayload) as { approved: boolean; note: string } | undefined
      const nextVersion = lastCompleteVersion(dev.dispositions) + 1
      const approved = payload?.approved ?? false
      const reviewer = inbox?.operator ?? conflictRecord?.reviewer ?? arg.operator
      dev.dispositions.push({
        version: nextVersion, kind: '复核', status: approved ? '已完成' : '进行中', operator: reviewer,
        note: approved ? `冲突重放复核通过：${payload?.note ?? ''}` : `冲突重放退回补证：${payload?.note ?? ''}`,
        investigation: clone(dev.investigation), reviewNote: payload?.note ?? '', reviewer,
        basedOnPlanVersion: draft.planVersion - 1, impactScope: dev.impactScope,
        evidenceRef: activeDisposition(dev)?.evidenceRef ?? '', createdAt: new Date().toISOString()
      })
      dev.version = nextVersion
      dev.reviewNote = payload?.note ?? ''
      dev.reviewer = reviewer
      dev.status = approved ? '已关闭' : '调查中'
      if (approved) {
        const batch = draft.batches.find((item) => item.id === dev.batchId)
        if (batch && blockingDeviations(draft, batch.id).length === 0) {
          batch.status = dev.investigation.decision === '报废' ? '已报废' : '待复核'
        }
      }
      mark(true, `冲突重放：复核签字生成${deviationId}处置版本V${nextVersion}，未覆盖先到一方版本`)
      return
    }

    if (kind === '放行签字') {
      const batchId = inbox?.batchId
      const payload = inbox?.payload as { signer: string; note: string } | undefined
      const batch = batchId ? draft.batches.find((item) => item.id === batchId) : undefined
      if (!batch || !payload || isBatchSigned(draft, batch.id) || blockingDeviations(draft, batch.id).length > 0 || batch.status !== '可放行') {
        mark(false, '放行签字重放条件已不满足（批次已由对方签字或状态变化），自动转为留档')
        return
      }
      draft.signatures.push({
        batchId: batch.id, signer: payload.signer, note: `冲突重放：${payload.note}`,
        dispositionVersions: snapshotDeviationVersions(draft, batch.id), planVersion: draft.planVersion - 1,
        signedAt: new Date().toISOString()
      })
      batch.status = '已放行'
      mark(true, `冲突重放：${batch.id}在最新版基础上完成签字放行；先到一方签字保持不变`)
      return
    }

    if (kind === '矩阵改版') {
      const incoming = inbox?.payload as ProcessStep | undefined
      const target = incoming ? draft.processSteps.find((item) => item.id === incoming.id) : undefined
      if (!incoming || !target) {
        mark(false, '矩阵改版重放条件已不满足，自动转为留档')
        return
      }
      Object.assign(target, incoming)
      mark(true, `冲突重放：${target.name}控制矩阵基于最新文档V${draft.planVersion}重新应用，请复核受影响偏差`)
      return
    }

    mark(false, '无法识别的冲突类型，转为留档')
  })

  if (result.kind !== 'committed') {
    api.dispatch(pushNotice({ level: 'error', title: '冲突处理写入失败', detail: '已保留全部既有版本，请重试。' }))
    return { ok: false, kind: 'write-failed', message: '冲突处理失败' }
  }
  api.dispatch(hydrateDoc(result.doc))
  return { ok: true, kind: 'committed', message: arg.resolution === 'replay' ? '冲突已基于最新版本重放' : '冲突已留档' }
})

/* ------------------------------------------------------------------ */
/* 重置演示：用一个新版本整体替换，审计中留痕                            */
/* ------------------------------------------------------------------ */

export const resetDemo = createAsyncThunk<ActionResult, void>('haccp/resetDemo', async (_unused, rawApi) => {
  const api = rawApi as unknown as SliceApi
  const result = appendOnLatest((draft) => {
    const seed = buildSeedPlan()
    const planVersion = draft.planVersion
    draft.processSteps = seed.processSteps
    draft.batches = seed.batches
    draft.deviations = seed.deviations
    draft.signatures = seed.signatures
    draft.conflictInbox = []
    draft.audit = [
      makeAudit('系统', '恢复演示数据', '当前用户', `重置为演示基线（作为文档V${planVersion}提交），此前版本不被覆盖`, planVersion),
      ...seed.audit.map((entry: AuditEntry) => ({ ...entry, planVersion }))
    ]
  })
  if (result.kind !== 'committed') {
    api.dispatch(pushNotice({ level: 'error', title: '重置失败', detail: '存储不可用，现有数据未受影响。' }))
    return { ok: false, kind: 'write-failed', message: '重置失败' }
  }
  api.dispatch(hydrateDoc(result.doc))
  return { ok: true, kind: 'committed', message: '已恢复演示数据' }
})

/* ------------------------------------------------------------------ */
/* 选择器                                                               */
/* ------------------------------------------------------------------ */

export function selectBatchDispositionSummary(doc: PlanDoc, batchId: string): { label: string; waiting: boolean; conflicting: boolean } {
  const related = doc.deviations.filter((item) => item.batchId === batchId)
  if (related.length === 0) return { label: '无偏差', waiting: false, conflicting: false }
  const parts = related.map((dev) => `${dev.id.replace('DEV-', 'D')}V${lastCompleteVersion(dev.dispositions)}`)
  const waiting = related.some((dev) => dev.pendingReeval)
  const conflicting = related.some((dev) => dev.dispositions.some((item) => item.status === '冲突待办' && !item.conflictResolved))
  return { label: parts.join(' '), waiting, conflicting }
}

export function selectOpenConflictCount(doc: PlanDoc): number {
  return openConflictCount(doc)
}

export { persist }
export default slice.reducer
