export type BatchStatus = '生产中' | '待复核' | '可放行' | '隔离中' | '已放行' | '已报废'
export type DeviationStatus = '待调查' | '调查中' | '待复核' | '已关闭'
export type DecisionType = '返工' | '报废' | '让步接收'

/** 处置版本所处阶段：等待重评来自控制矩阵关键限值/纠偏措施变化。 */
export type DispositionStatus = '进行中' | '待复核' | '等待重评' | '已完成' | '冲突待办'
export type DispositionKind = '登记' | '调查' | '重评' | '复核'
export type ConflictKind = '调查提交' | '复核签字' | '重评' | '放行签字' | '矩阵改版'

export interface ProcessStep {
  id: string
  name: string
  equipment: string
  hazard: string
  controlPoint: string
  limit: string
  frequency: string
  correctiveAction: string
}

export interface MonitoringValue {
  stepId: string
  value: number
  unit: string
  recordedAt: string
  operator: string
}

export interface Batch {
  id: string
  product: string
  line: string
  quantity: number
  producedAt: string
  status: BatchStatus
  isolationScope: string
  monitoring: MonitoringValue[]
  version: number
}

export interface Investigation {
  cause: string
  evidence: string
  decision: DecisionType
  reworkInstruction: string
}

/**
 * 偏差处置的一个完整版本：调查/复核的每个可审计阶段都是一条不可改写的版本记录，
 * 矩阵改版会把未关闭版本置为“等待重评”，冲突提交会生成“冲突待办”版本。
 */
export interface DispositionVersion {
  version: number
  kind: DispositionKind
  status: DispositionStatus
  operator: string
  note: string
  investigation: Investigation
  reviewNote: string
  reviewer: string
  /** 本版本依据的控制矩阵版本；矩阵升版后未关闭版本据此判定需要重评。 */
  basedOnPlanVersion: number
  /** 触发等待重评的矩阵版本。 */
  reevalRequiredByPlan?: number
  impactScope: string
  evidenceRef: string
  createdAt: string
  /** 冲突待办：与哪个处置版本冲突（同偏差同版本号）。 */
  conflictsWithVersion?: number
  /** 冲突待办：被冲突挡住时，该窗口原本要提交的内容。 */
  conflictKind?: ConflictKind
  conflictWindowId?: string
  conflictPayload?: Investigation
    | { approved: boolean; note: string }
    | { id: string; investigation: Investigation; notice: string; reviewer: string }
    | { signer: string; note: string }
    | ProcessStep
  conflictResolved?: boolean
  /** 冲突处理结果。 */
  resolvedAt?: string
  resolvedBy?: string
  resolution?: '已重放' | '已留档'
}

export interface Deviation {
  id: string
  batchId: string
  stepId: string
  title: string
  severity: '一般' | '重大'
  status: DeviationStatus
  owner: string
  openedAt: string
  dueDate: string
  investigation: Investigation
  reviewNote: string
  reviewer: string
  /** 展示用流水号；权威版本以 dispositions 为准。 */
  version: number
  /** 影响范围：隔离批次、在制品区间等，矩阵改版时同步复核。 */
  impactScope: string
  /** 等待重评时锁定处置，直至质量负责人重评确认。 */
  pendingReeval: boolean
  reevalReason: string
  /** 完整处置版本链（不可改写，只追加）。 */
  dispositions: DispositionVersion[]
}

/** 批次放行签字；签字后批次即冻结，矩阵改版不再改写。 */
export interface ReleaseSignature {
  batchId: string
  signer: string
  note: string
  dispositionVersions: Record<string, number>
  planVersion: number
  signedAt: string
}

/** 冲突待办：后到一方的提交不会覆盖先到一方，证据与意图保留在此等待人工处理。 */
export interface ConflictTodo {
  id: string
  kind: ConflictKind
  entity: string
  batchId: string
  stepId?: string
  deviationId?: string
  /** 冲突的同处置版本号（适用时）。 */
  dispositionVersion?: number
  windowId: string
  operator: string
  summary: string
  payload: unknown
  createdAt: string
  status: '待处理' | '已重放' | '已留档'
  resolvedAt?: string
  resolvedBy?: string
  resolutionNote?: string
}

export interface AuditEntry {
  id: string
  entity: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 产生该事件时的文档（控制矩阵）版本，批次列表/工作台/审计据此显示同一处置版本。 */
  planVersion: number
  /** 关联偏差的处置版本号（如有）。 */
  dispositionVersion?: number
  /** 冲突待办标记。 */
  conflict?: boolean
  windowId?: string
}

export interface PlanDoc {
  /** 文档版本：每次完整提交（一个处置版本）CAS 递增；0 为旧数据迁移基线。 */
  planVersion: number
  processSteps: ProcessStep[]
  batches: Batch[]
  deviations: Deviation[]
  signatures: ReleaseSignature[]
  conflictInbox: ConflictTodo[]
  audit: AuditEntry[]
}
