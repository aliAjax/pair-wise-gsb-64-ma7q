import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { seedAudit, seedBatches, seedDeviations, processSteps } from '../data/seed'
import type { AuditEntry, Batch, BatchStatus, Deviation, DeviationStatus, Investigation, ProcessStep } from '../types'

interface HaccpState {
  batches: Batch[]
  deviations: Deviation[]
  processSteps: ProcessStep[]
  audit: AuditEntry[]
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  selectedBatchId: string | null
}

interface PersistedState extends HaccpState {}
const STORAGE_KEY = 'gsb64:haccp-platform'

function initialState(): HaccpState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // Seed data remains available when local storage is unavailable or corrupt.
  }
  return { batches: seedBatches, deviations: seedDeviations, processSteps, audit: seedAudit, batchFilter: '', batchStatus: '全部', selectedBatchId: seedBatches[0].id }
}

const slice = createSlice({
  name: 'haccp',
  initialState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },
    updateProcessStep(state, action: PayloadAction<ProcessStep>) {
      const index = state.processSteps.findIndex((item) => item.id === action.payload.id)
      if (index >= 0) state.processSteps[index] = action.payload
      log(state, action.payload.id, '修改控制措施', '质量主管', `更新${action.payload.name}关键限值或监控要求`)
    },
    updateBatchStatus(state, action: PayloadAction<{ id: string; status: BatchStatus }>) {
      const batch = state.batches.find((item) => item.id === action.payload.id)
      if (!batch) return
      const blocking = state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭')
      if (action.payload.status === '可放行' && blocking) return
      batch.status = action.payload.status
      batch.version += 1
      log(state, batch.id, '批次状态流转', '质量主管', `状态更新为${action.payload.status}`)
    },
    createDeviation(state, action: PayloadAction<{ batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch) return
      const now = new Date().toISOString()
      const deviation: Deviation = {
        id: `DEV-${Date.now().toString().slice(-8)}`, ...action.payload, status: '待调查', openedAt: now,
        dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), reviewNote: '', reviewer: '', version: 1,
        investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }
      }
      state.deviations.unshift(deviation)
      batch.status = '隔离中'
      batch.version += 1
      log(state, deviation.id, '创建偏差调查', '当前用户', `批次${batch.id}因${action.payload.title}进入隔离`)
    },
    saveInvestigation(state, action: PayloadAction<{ id: string; investigation: Investigation }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation || !action.payload.investigation.cause.trim() || !action.payload.investigation.evidence.trim()) return
      deviation.investigation = action.payload.investigation
      deviation.status = '待复核'
      deviation.version += 1
      log(state, deviation.id, '提交偏差调查', deviation.owner, `处置分支：${deviation.investigation.decision}`)
    },
    reviewDeviation(state, action: PayloadAction<{ id: string; approved: boolean; note: string; reviewer: string }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation) return
      if (action.payload.approved && !action.payload.note.trim()) return
      deviation.reviewNote = action.payload.note
      deviation.reviewer = action.payload.reviewer
      deviation.status = action.payload.approved ? '已关闭' : '调查中'
      deviation.version += 1
      const batch = state.batches.find((item) => item.id === deviation.batchId)
      if (batch && action.payload.approved && !state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭' && item.id !== deviation.id)) {
        batch.status = deviation.investigation.decision === '报废' ? '已报废' : '待复核'
        batch.version += 1
      }
      log(state, deviation.id, action.payload.approved ? '复核通过' : '退回补证', action.payload.reviewer, action.payload.note || '退回调查')
    },
    resetDemo(state) {
      const fresh = { batches: seedBatches, deviations: seedDeviations, processSteps, audit: seedAudit, batchFilter: '', batchStatus: '全部' as const, selectedBatchId: seedBatches[0].id }
      return fresh
    }
  }
})

function log(state: HaccpState, entity: string, action: string, operator: string, detail: string) {
  state.audit.unshift({ id: nanoid(), entity, action, operator, detail, createdAt: new Date().toISOString() })
}

export const { setBatchFilter, setBatchStatus, setSelectedBatch, updateProcessStep, updateBatchStatus, createDeviation, saveInvestigation, reviewDeviation, resetDemo } = slice.actions
export type { PersistedState }
export default slice.reducer
