import type { AuditEntry, Batch, Deviation, DispositionVersion, PlanDoc, ProcessStep, ReleaseSignature } from '../types'

export const processSteps: ProcessStep[] = [
  { id: 'P1', name: '原料验收', equipment: '冷藏收货台', hazard: '致病菌、温度失控', controlPoint: '原料中心温度', limit: '≤ 4 ℃', frequency: '每批', correctiveAction: '拒收并隔离供应商批次' },
  { id: 'P2', name: '巴氏杀菌', equipment: 'HTST-02', hazard: '致病菌残留', controlPoint: '杀菌温度', limit: '≥ 72 ℃ / 15 s', frequency: '连续记录', correctiveAction: '自动回流并触发偏差' },
  { id: 'P3', name: '金属探测', equipment: 'MD-06', hazard: '金属异物', controlPoint: 'Fe/SUS灵敏度', limit: 'Fe 1.5 mm / SUS 2.0 mm', frequency: '每半小时', correctiveAction: '隔离末次合格点以来产品' },
  { id: 'P4', name: '灌装封口', equipment: 'FILL-01', hazard: '密封不良', controlPoint: '封口压力', limit: '0.38-0.45 MPa', frequency: '每小时', correctiveAction: '停机调机并复检留样' },
  { id: 'P5', name: '终产品冷却', equipment: '冷却隧道', hazard: '芽孢萌发', controlPoint: '冷却结束温度', limit: '≤ 10 ℃ / 2 h', frequency: '每批', correctiveAction: '延长冷却并观察质量' }
]

export const seedBatches: Batch[] = [
  {
    id: 'B260929-01', product: '低温鲜奶 950mL', line: 'L1', quantity: 3200, producedAt: '2026-09-29T06:20:00', status: '隔离中', isolationScope: '杀菌后至金属探测前全部在制品', version: 4,
    monitoring: [
      { stepId: 'P1', value: 3.4, unit: '℃', recordedAt: '2026-09-29T06:25:00', operator: '陈莉' },
      { stepId: 'P2', value: 70.8, unit: '℃', recordedAt: '2026-09-29T06:48:00', operator: '系统采集' },
      { stepId: 'P3', value: 1.5, unit: 'mm Fe', recordedAt: '2026-09-29T07:20:00', operator: '杨鸣' }
    ]
  },
  {
    id: 'B260929-02', product: '原味酸奶 200g', line: 'L2', quantity: 8600, producedAt: '2026-09-29T08:10:00', status: '待复核', isolationScope: 'FILL-01本次清洁后产品', version: 3,
    monitoring: [
      { stepId: 'P4', value: 0.36, unit: 'MPa', recordedAt: '2026-09-29T08:40:00', operator: '系统采集' },
      { stepId: 'P5', value: 8.2, unit: '℃', recordedAt: '2026-09-29T10:10:00', operator: '郑凯' }
    ]
  },
  {
    id: 'B260928-07', product: '低脂牛奶 1L', line: 'L1', quantity: 5100, producedAt: '2026-09-28T16:20:00', status: '已放行', isolationScope: '无', version: 6,
    monitoring: processSteps.map((step, index) => ({ stepId: step.id, value: [3.0, 73.2, 1.2, 0.41, 7.8][index], unit: ['℃', '℃', 'mm Fe', 'MPa', '℃'][index], recordedAt: '2026-09-28T17:00:00', operator: '生产线记录' }))
  }
]

const dev1Dispositions = (impactScope: string): DispositionVersion[] => [
  {
    version: 1, kind: '登记', status: '已完成', operator: '监控系统', note: '杀菌温度70.8℃低于限值72℃，自动登记', investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }, reviewNote: '', reviewer: '', basedOnPlanVersion: 2, impactScope, evidenceRef: '', createdAt: '2026-09-29T06:55:00'
  },
  {
    version: 2, kind: '登记', status: '已完成', operator: '监控系统', note: '系统初判', investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }, reviewNote: '', reviewer: '', basedOnPlanVersion: 2, impactScope, evidenceRef: '', createdAt: '2026-09-29T06:56:00'
  },
  {
    version: 3, kind: '调查', status: '待复核', operator: '质量工程组', note: '提交调查：蒸汽调节阀响应滞后', investigation: { cause: '蒸汽调节阀响应滞后', evidence: '趋势图显示70.8℃持续42秒；阀门检修记录已上传', decision: '返工', reworkInstruction: '隔离产品全部回流至平衡槽，重新杀菌并留样验证' }, reviewNote: '', reviewer: '', basedOnPlanVersion: 2, impactScope, evidenceRef: '趋势图#T-260929-02；阀门检修记录#R-260929-11', createdAt: '2026-09-29T08:15:00'
  }
]

const dev2Dispositions = (impactScope: string): DispositionVersion[] => [
  {
    version: 1, kind: '登记', status: '已完成', operator: '杨鸣', note: '封口压力0.36MPa低于0.38MPa，登记隔离', investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }, reviewNote: '', reviewer: '', basedOnPlanVersion: 2, impactScope, evidenceRef: '', createdAt: '2026-09-29T08:52:00'
  },
  {
    version: 2, kind: '调查', status: '待复核', operator: '设备保障组', note: '提交调查：气缸密封圈磨损', investigation: { cause: '气缸密封圈磨损', evidence: '压力曲线、拆检照片、备件领用单', decision: '返工', reworkInstruction: '更换密封圈，返封隔离产品并恢复压力。' }, reviewNote: '', reviewer: '', basedOnPlanVersion: 2, impactScope, evidenceRef: '压力曲线#C-260929-07；拆检照片#P-260929-03', createdAt: '2026-09-29T09:40:00'
  }
]

export const seedDeviations: Deviation[] = [
  {
    id: 'DEV-260929-01', batchId: 'B260929-01', stepId: 'P2', title: '杀菌温度低于关键限值', severity: '重大', status: '待复核', owner: '质量工程组', openedAt: '2026-09-29T06:55:00', dueDate: '2026-09-29', version: 3,
    impactScope: '杀菌后至金属探测前全部在制品（B260929-01，约3200件）', pendingReeval: false, reevalReason: '',
    investigation: { cause: '蒸汽调节阀响应滞后', evidence: '趋势图显示70.8℃持续42秒；阀门检修记录已上传', decision: '返工', reworkInstruction: '隔离产品全部回流至平衡槽，重新杀菌并留样验证' }, reviewNote: '', reviewer: '',
    dispositions: dev1Dispositions('杀菌后至金属探测前全部在制品（B260929-01，约3200件）')
  },
  {
    id: 'DEV-260929-02', batchId: 'B260929-02', stepId: 'P4', title: '封口压力偏低', severity: '一般', status: '待复核', owner: '设备保障组', openedAt: '2026-09-29T08:52:00', dueDate: '2026-09-30', version: 2,
    impactScope: 'FILL-01本次清洁后产品（B260929-02，约8600件）', pendingReeval: false, reevalReason: '',
    investigation: { cause: '气缸密封圈磨损', evidence: '压力曲线、拆检照片、备件领用单', decision: '返工', reworkInstruction: '更换密封圈，返封隔离产品并恢复压力。' }, reviewNote: '', reviewer: '',
    dispositions: dev2Dispositions('FILL-01本次清洁后产品（B260929-02，约8600件）')
  }
]

const auditBase = (planVersion: number): AuditEntry[] => [
  { id: 'AUD-1', entity: 'B260929-01', action: '自动创建偏差', operator: '监控系统', detail: '杀菌温度70.8℃低于限值72℃，批次已隔离（处置版本V1）', createdAt: '2026-09-29T06:55:00', planVersion, dispositionVersion: 1 },
  { id: 'AUD-2', entity: 'DEV-260929-01', action: '提交调查', operator: '质量工程组', detail: '记录蒸汽阀响应滞后与趋势证据（处置版本V3）', createdAt: '2026-09-29T08:15:00', planVersion, dispositionVersion: 3 },
  { id: 'AUD-3', entity: 'B260929-02', action: '状态流转', operator: '杨鸣', detail: '由生产中转为待复核', createdAt: '2026-09-29T08:52:00', planVersion }
]

const seedSignatures: ReleaseSignature[] = [
  {
    batchId: 'B260928-07', signer: '质量负责人 秦岚', note: '监测全部合格，同意放行', dispositionVersions: {}, planVersion: 2, signedAt: '2026-09-28T18:05:00'
  }
]

/** 全新环境的基线计划文档：处置版本从矩阵V2开始（V1为初始发布）。 */
export function buildSeedPlan(): PlanDoc {
  return {
    planVersion: 2,
    processSteps: structuredClone(processSteps),
    batches: structuredClone(seedBatches),
    deviations: structuredClone(seedDeviations),
    signatures: structuredClone(seedSignatures),
    conflictInbox: [],
    audit: auditBase(2)
  }
}
