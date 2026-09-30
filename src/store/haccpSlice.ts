import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit'
import { migrate, buildCommit, resolveConflict, type Intent } from '../services/engine'
import { clearPending, loadRawSnapshot, readPending, saveSnapshot, windowId, writePending } from '../services/storage'
import type { BatchStatus, HaccpState } from '../types'

export const CURRENT_OPERATOR = '质量主管'

/** 组件只关心提交结果；引擎保证失败时状态不产生半套变更 */
export type CommitOutcome =
  | { status: 'committed'; seq: number }
  | { status: 'conflict'; conflictId: string; seq: number }
  | { status: 'invalid'; message: string }
  | { status: 'persist-failed'; seq: number; conflictId?: string; message: string }

interface CommitArgs {
  intent: Intent
  /** 编辑所依据的版本；缺省取最新版本 */
  baseSeq?: number
  operator?: string
}

/**
 * 可恢复的原子提交流程：
 * 1) 前写日志先落盘（含意图与基准版本）；
 * 2) 引擎整版计算（OCC 冲突检测、偏差冻结、签字保护）；
 * 3) 完整快照一次写入——成功才清日志；失败保留日志并可接着最后完整版本重做。
 */
export const commitIntent = createAsyncThunk<CommitOutcome, CommitArgs>('haccp/commit', async (args, { getState, dispatch }) => {
  const root = getState() as { haccp: HaccpState }
  const state = root.haccp
  const baseSeq = args.baseSeq ?? state.dispositionSeq
  const operator = args.operator ?? CURRENT_OPERATOR
  const ctx = { origin: windowId, operator }

  writePending(windowId, { intent: args.intent, origin: windowId, operator, baseSeq, startedAt: new Date().toISOString() })

  const result = buildCommit(state, args.intent, baseSeq, ctx)
  if (!result.ok && result.reason === 'error') {
    clearPending(windowId)
    return { status: 'invalid', message: result.message }
  }

  const next = result.state
  const seq = next.dispositionSeq
  if (result.ok) {
    try {
      saveSnapshot(next)
      clearPending(windowId)
    } catch {
      // 快照未落盘：内存先呈现新版本，前写日志保留，重载或手动恢复时从最后完整版本重做
      dispatch(haccpSlice.actions.hydrate(next))
      return { status: 'persist-failed', seq, message: `主快照写入失败：V${seq} 未持久化，已保留恢复日志` }
    }
    dispatch(haccpSlice.actions.hydrate(next))
    return { status: 'committed', seq }
  }

  try {
    saveSnapshot(next)
    clearPending(windowId)
  } catch {
    dispatch(haccpSlice.actions.hydrate(next))
    return { status: 'persist-failed', seq, conflictId: result.conflictId, message: '主快照写入失败：冲突待办已在内存登记，可按恢复日志重做' }
  }
  dispatch(haccpSlice.actions.hydrate(next))
  return { status: 'conflict', conflictId: result.conflictId, seq }
})

/** 冲突待办：续提（变基到最新完整版本重做）或放弃（对方证据/签字保持有效） */
export const resolveConflictThunk = createAsyncThunk<CommitOutcome, { conflictId: string; action: 'continue' | 'abandon' }>(
  'haccp/resolve-conflict',
  async ({ conflictId, action }, { getState, dispatch }) => {
    const state = (getState() as { haccp: HaccpState }).haccp
    const ctx = { origin: windowId, operator: CURRENT_OPERATOR }
    const pending = readPending(windowId)
    // 复用前写日志通道：恢复时同样能续做冲突决议
    writePending(windowId, { intent: { __conflict: conflictId, __action: action } as unknown, origin: windowId, operator: ctx.operator, baseSeq: state.dispositionSeq, startedAt: new Date().toISOString() })
    const result = resolveConflict(state, conflictId, action, ctx)
    if (!result.ok) {
      if (pending) writePending(windowId, pending)
      else clearPending(windowId)
      const message = result.reason === 'conflict' ? '冲突决议再次冲突' : result.message
      return { status: 'invalid', message }
    }
    try {
      saveSnapshot(result.state)
      clearPending(windowId)
    } catch {
      dispatch(haccpSlice.actions.hydrate(result.state))
      return { status: 'persist-failed', seq: result.state.dispositionSeq, message: '主快照写入失败，冲突决议待恢复日志重做' }
    }
    dispatch(haccpSlice.actions.hydrate(result.state))
    return { status: 'committed', seq: result.state.dispositionSeq }
  }
)

/** 写入失败后手动恢复：重读最后完整快照 + 本窗口前写日志，接着完整版本重做 */
export const recoverPending = createAsyncThunk<{ report: string }, void>('haccp/recover', async (_, { dispatch }) => {
  const base = migrate(loadRawSnapshot())
  const pending = readPending(windowId)
  if (!pending) {
    dispatch(haccpSlice.actions.hydrate(base))
    return { report: '未发现待恢复提交，已回到最后完整版本。' }
  }

  const conflictIntent = pending.intent as { __conflict?: string; __action?: 'continue' | 'abandon' }
  if (conflictIntent.__conflict) {
    const result = resolveConflict(base, conflictIntent.__conflict, conflictIntent.__action ?? 'continue', { origin: pending.origin, operator: pending.operator })
    if (result.ok) {
      saveSnapshot(result.state)
      clearPending(windowId)
      dispatch(haccpSlice.actions.hydrate(result.state))
      return { report: `恢复完成：冲突决议已续做到 V${result.state.dispositionSeq}。` }
    }
    dispatch(haccpSlice.actions.hydrate(result.state))
    return { report: `恢复中止：${result.reason === 'conflict' ? '处置再次冲突，已登记新待办' : result.message}` }
  }

  const result = buildCommit(base, pending.intent as Intent, pending.baseSeq, { origin: pending.origin, operator: pending.operator })
  if (!result.ok && result.reason === 'error') {
    dispatch(haccpSlice.actions.hydrate(result.state))
    return { report: `恢复中止：${result.message}` }
  }
  try {
    saveSnapshot(result.state)
    clearPending(windowId)
  } catch {
    dispatch(haccpSlice.actions.hydrate(result.state))
    return { report: '主快照仍不可写：恢复日志已保留，可稍后重试。' }
  }
  dispatch(haccpSlice.actions.hydrate(result.state))
  if (!result.ok) {
    return { report: `恢复完成：提交期间对方已推进版本，已转入冲突待办 ${result.conflictId}。` }
  }
  return { report: `恢复完成：已从 V${pending.baseSeq} 续做到完整版本 V${result.seq}。` }
})

/** 启动恢复：旧数据迁移 → 持久化补齐后的 V1 → 重放本窗口未完成的提交 */
export const bootstrap = createAsyncThunk<{ report: string }, void>('haccp/bootstrap', async (_, { dispatch }) => {
  const raw = loadRawSnapshot()
  const base = migrate(raw)
  dispatch(haccpSlice.actions.hydrate(base))
  // 旧数据首次打开：补齐后的 V1（含版本链/影响范围/历史签字）立即落盘
  const isV2 = !!raw && (raw as { schemaVersion?: number }).schemaVersion === 2
  if (!isV2) {
    try { saveSnapshot(base) } catch { /* 存储不可用时仍可内存使用，下次提交的 WAL 兜底 */ }
  }
  const pending = readPending(windowId)
  if (!pending) return { report: '' }
  const result = await dispatch(recoverPending())
  return (result as { payload: { report: string } }).payload
})

/** 恢复演示数据：同时清空本窗口残留的前写日志 */
export const resetDemo = createAsyncThunk<void, void>('haccp/reset', async (_, { dispatch }) => {
  const fresh = migrate(null)
  try { saveSnapshot(fresh) } catch { /* 故障模拟下重置仍在内存生效 */ }
  clearPending(windowId)
  dispatch(haccpSlice.actions.hydrate(fresh))
})

interface HaccpViewState extends HaccpState {}

function bootState(): HaccpViewState {
  return migrate(loadRawSnapshot())
}

const haccpSlice = createSlice({
  name: 'haccp',
  initialState: bootState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },
    /** 以一个完整版本快照整体替换内存状态（版本、审计、业务数据同进同出） */
    hydrate(state, action: PayloadAction<HaccpState>) {
      const ui = { batchFilter: state.batchFilter, batchStatus: state.batchStatus, selectedBatchId: state.selectedBatchId }
      return { ...action.payload, ...ui }
    }
  }
})

export const { setBatchFilter, setBatchStatus, setSelectedBatch } = haccpSlice.actions
export default haccpSlice.reducer
