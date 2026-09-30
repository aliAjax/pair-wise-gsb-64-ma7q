export type BatchStatus = '生产中' | '待复核' | '可放行' | '隔离中' | '已放行' | '已报废'
// 待重评：关键限值/纠偏措施变更后，未关闭偏差冻结证据、等待重新评估
export type DeviationStatus = '待调查' | '调查中' | '待复核' | '待重评' | '已关闭'
export type DecisionType = '返工' | '报废' | '让步接收'

export interface ProcessStep {
  id: string
  name: string
  equipment: string
  hazard: string
  controlPoint: string
  limit: string
  frequency: string
  correctiveAction: string
  /** 该控制项当前内容对应的处置版本 */
  dispositionSeq: number
}

export interface MonitoringValue {
  stepId: string
  value: number
  unit: string
  recordedAt: string
  operator: string
}

export interface ReleaseSignature {
  seq: number
  operator: string
  signedAt: string
  /** 签字依据的关键限值版本，签字后不可被矩阵改写 */
  basisSeq: number
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
  /** @deprecated 旧字段，迁移后仅保留展示 */
  version: number
  /** 批次当前所处的处置版本 */
  dispositionSeq: number
  /** 放行签字；一旦存在即冻结，后续矩阵版本不再改写批次 */
  release?: ReleaseSignature
}

export interface Investigation {
  cause: string
  evidence: string
  decision: DecisionType
  reworkInstruction: string
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
  /** @deprecated 旧字段 */
  version: number
  /** 偏差当前所处的处置版本 */
  dispositionSeq: number
  /** 触发重评的矩阵版本；证据保留在 investigation 中不被覆盖 */
  reassessFromSeq?: number
  reassessReason?: string
}

export type DispositionKind =
  | '基线'
  | '迁移'
  | '矩阵变更'
  | '偏差登记'
  | '调查提交'
  | '复核结论'
  | '批次流转'
  | '放行签字'
  | '冲突登记'
  | '冲突续提'
  | '放弃冲突'
  | '演示重置'

/** 一条完整、不可分割的处置版本 */
export interface DispositionVersion {
  seq: number
  kind: DispositionKind
  /** 发起窗口标识 */
  origin: string
  operator: string
  createdAt: string
  summary: string
  /** 影响范围：受影响的批次、偏差、控制点 */
  impact: {
    batches: string[]
    deviations: string[]
    steps: string[]
    /** 已签字放行、按版本冻结未被改写的批次 */
    frozenReleased: string[]
  }
}

export interface AuditEntry {
  id: string
  /** 该审计事件所属处置版本；半套提交不会留下审计 */
  dispositionSeq: number
  entity: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

/** 两窗口同版本并发提交时，后到一方的处置原样保留为冲突待办 */
export interface ConflictRecord {
  id: string
  /** 冲突提交所基于的旧版本号 */
  baseSeq: number
  /** 对方先提交的版本号 */
  winnerSeq: number
  origin: string
  operator: string
  createdAt: string
  kind: DispositionKind
  summary: string
  /** 序列化后的处置意图，续提时可重放 */
  intent: unknown
  status: '待处理' | '已续提' | '已放弃'
  resolvedAt?: string
  resolvedSeq?: number
}

export interface HaccpState {
  schemaVersion: 2
  dispositionSeq: number
  versions: DispositionVersion[]
  conflicts: ConflictRecord[]
  batches: Batch[]
  deviations: Deviation[]
  processSteps: ProcessStep[]
  audit: AuditEntry[]
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  selectedBatchId: string | null
  /** 当前窗口标识（不持久化，启动时按会话补齐） */
  windowId?: string
}

/** 预写日志：先落盘的一整套处置，提交中断后可重做 */
export interface PendingCommit {
  intent: unknown
  origin: string
  operator: string
  baseSeq: number
  startedAt: string
}
