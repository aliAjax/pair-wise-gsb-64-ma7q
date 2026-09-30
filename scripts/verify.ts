/* 引擎不变量验证：通过 `node scripts/verify.mjs`（经 esbuild 打包）运行 */
import { migrate, buildCommit, resolveConflict } from '../src/services/engine'
import { seedBatches } from '../src/data/seed'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name} ${detail}`) }
}

/* 1. 旧数据首次打开迁移 */
console.log('\n[1] 旧数据迁移')
const legacy = {
  batches: seedBatches,
  deviations: [],
  processSteps: [],
  audit: [],
  batchFilter: '', batchStatus: '全部', selectedBatchId: null
}
const s1 = migrate(legacy)
check('迁移后 schemaVersion=2', s1.schemaVersion === 2)
check('处置版本从 V1 开始', s1.dispositionSeq === 1 && s1.versions.length === 1 && s1.versions[0].kind === '迁移')
const released = s1.batches.find((b) => b.id === 'B260928-07')!
check('已放行批次补录签字并冻结', !!released.release && released.release.basisSeq === 1)
check('批次状态/版本旧字段照旧保留', released.status === '已放行' && released.version === 6)
check('空数据走 seed 迁移', migrate(null).dispositionSeq === 1)
check('v2 快照迁移幂等直通', migrate({ ...s1 }).dispositionSeq === 1)

/* 准备：为 P5 制造一个未关闭偏差（B260929-02 上，P5 控制点无其他偏差） */
let s = migrate(null)
const c = (s: any) => ({ origin: 'WIN-T1', operator: '测试员' })
let r = buildCommit(s, { type: 'deviationCreate', batchId: 'B260929-02', stepId: 'P5', title: '测试冷却温度偏差', severity: '重大', owner: '测试组' }, s.dispositionSeq, c(s))
check('登记偏差成功 V2', r.ok, JSON.stringify(r))
s = (r as any).state

/* 2. 关键限值变化 → 未关闭偏差保留证据、待重评 */
console.log('\n[2] 矩阵变更联动重评')
const devBefore = s.deviations.find((d: any) => d.stepId === 'P5' && d.status !== '已关闭')
const evidenceBefore = devBefore.investigation.evidence || ''
// 先给偏差填一份调查证据
r = buildCommit(s, { type: 'investigationSave', deviationId: devBefore.id, investigation: { cause: '冷却能力不足', evidence: '温度曲线8.2℃持续20分钟', decision: '返工', reworkInstruction: '延长冷却' } }, s.dispositionSeq, c(s))
check('提交调查 V3', r.ok); s = (r as any).state
r = buildCommit(s, { type: 'matrixChange', stepId: 'P5', limit: '≤ 9 ℃ / 2 h', frequency: s.processSteps.find((x: any) => x.id === 'P5').frequency, correctiveAction: s.processSteps.find((x: any) => x.id === 'P5').correctiveAction }, s.dispositionSeq, c(s))
check('矩阵变更提交 V4', r.ok); s = (r as any).state
const devAfter = s.deviations.find((d: any) => d.id === devBefore.id)
check('偏差转为待重评', devAfter.status === '待重评')
check('证据原样保留', devAfter.investigation.evidence === '温度曲线8.2℃持续20分钟')
check('记录重评来源版本', devAfter.reassessFromSeq === 3)
check('关联批次维持隔离', s.batches.find((b: any) => b.id === 'B260929-02').status === '隔离中')
check('审计中留有证据快照', s.audit.some((a: any) => a.action === '偏差待重评' && a.detail.includes('温度曲线8.2℃持续20分钟')))
check('版本影响范围含偏差与批次', s.versions[0].impact.deviations.includes(devBefore.id) && s.versions[0].impact.batches.includes('B260929-02'))

/* 仅频率变化不触发重评 */
const reassessAuditBefore = s.audit.filter((a: any) => a.action === '偏差待重评').length
r = buildCommit(s, { type: 'matrixChange', stepId: 'P1', limit: s.processSteps.find((x: any) => x.id === 'P1').limit, frequency: '每两批', correctiveAction: s.processSteps.find((x: any) => x.id === 'P1').correctiveAction }, s.dispositionSeq, c(s))
check('仅频率变更成功且无重评', r.ok); s = (r as any).state
check('无新增待重评审计', s.audit.filter((a: any) => a.action === '偏差待重评').length === reassessAuditBefore)

/* 待重评偏差阻止放行、且不能直接复核 */
r = buildCommit(s, { type: 'batchTransition', batchId: 'B260929-02', status: '可放行' }, s.dispositionSeq, c(s))
check('待重评偏差阻止可放行', !r.ok && (r as any).reason === 'error')
r = buildCommit(s, { type: 'review', deviationId: devAfter.id, approved: true, note: 'x' }, s.dispositionSeq, c(s))
check('待重评偏差不能直接复核', !r.ok && (r as any).reason === 'error')

/* 重评后重新提交调查 → 待复核 → 关闭 */
r = buildCommit(s, { type: 'investigationSave', deviationId: devAfter.id, investigation: { cause: '冷却能力不足（按9℃重评）', evidence: '温度曲线8.2℃持续20分钟 + 新限值比对', decision: '返工', reworkInstruction: '延长冷却' } }, s.dispositionSeq, c(s))
check('重评后提交调查', r.ok); s = (r as any).state
check('偏差回待复核、重评标记清除', s.deviations.find((d: any) => d.id === devAfter.id).status === '待复核' && !s.deviations.find((d: any) => d.id === devAfter.id).reassessFromSeq)
r = buildCommit(s, { type: 'review', deviationId: devAfter.id, approved: true, note: '证据充分' }, s.dispositionSeq, c(s))
check('复核通过关闭 V', r.ok); s = (r as any).state
// 该批次 seed 中还有 DEV-260929-02（P4 待复核），一并关闭以走通放行
const seedDev = s.deviations.find((d: any) => d.id === 'DEV-260929-02')
if (seedDev && seedDev.status === '待复核') {
  r = buildCommit(s, { type: 'review', deviationId: seedDev.id, approved: true, note: '证据充分' }, s.dispositionSeq, c(s))
  check('关闭批次上剩余 seed 偏差', r.ok); s = (r as any).state
}

/* 3. 已签字放行批次不被矩阵改写 */
console.log('\n[3] 放行签字冻结')
check('已放行批次 V1 release 存在', s.batches.find((b: any) => b.id === 'B260928-07').release)
// 把另一批次走完整放行链路
r = buildCommit(s, { type: 'batchTransition', batchId: 'B260929-02', status: '可放行' }, s.dispositionSeq, c(s))
check('偏差全部关闭后可提交放行复核', r.ok, (r as any).message ?? ''); s = (r as any).state
r = buildCommit(s, { type: 'releaseSign', batchId: 'B260929-02' }, s.dispositionSeq, c(s))
check('签字放行成功', r.ok, (r as any).message ?? ''); s = (r as any).state
const seqAtSign = s.dispositionSeq
check('签字记录含依据版本', s.batches.find((b: any) => b.id === 'B260929-02').release.seq === seqAtSign)
// 再在该批次上登记偏差被拒
r = buildCommit(s, { type: 'deviationCreate', batchId: 'B260929-02', stepId: 'P5', title: '签字后偏差', severity: '一般', owner: 'x' }, s.dispositionSeq, c(s))
check('已放行批次不能登记偏差', !r.ok)
// 再改 P5 限值：已放行批次无开放偏差、不被改写
const batchStampBefore = s.batches.find((b: any) => b.id === 'B260929-02').dispositionSeq
r = buildCommit(s, { type: 'matrixChange', stepId: 'P5', limit: '≤ 8 ℃ / 2 h', frequency: s.processSteps.find((x: any) => x.id === 'P5').frequency, correctiveAction: s.processSteps.find((x: any) => x.id === 'P5').correctiveAction }, s.dispositionSeq, c(s))
check('矩阵继续演进成功', r.ok); s = (r as any).state
check('已放行批次未被改写（版本戳不动）', s.batches.find((b: any) => b.id === 'B260929-02').dispositionSeq === batchStampBefore && s.batches.find((b: any) => b.id === 'B260929-02').status === '已放行')
check('已放行批次签字仍在', !!s.batches.find((b: any) => b.id === 'B260929-02').release)

/* 4. 两窗口并发：后到方冲突待办，不覆盖证据/签字 */
console.log('\n[4] 并发冲突')
const base = s.dispositionSeq
const rA = buildCommit(s, { type: 'matrixChange', stepId: 'P3', limit: 'Fe 1.2 mm / SUS 1.8 mm', frequency: s.processSteps.find((x: any) => x.id === 'P3').frequency, correctiveAction: s.processSteps.find((x: any) => x.id === 'P3').correctiveAction }, base, { origin: 'WIN-A', operator: '窗口A' })
check('窗口A 提交成功', rA.ok); const sA = (rA as any).state
const rB = buildCommit(sA, { type: 'matrixChange', stepId: 'P4', limit: '0.40-0.46 MPa', frequency: sA.processSteps.find((x: any) => x.id === 'P4').frequency, correctiveAction: sA.processSteps.find((x: any) => x.id === 'P4').correctiveAction }, base, { origin: 'WIN-B', operator: '窗口B' })
check('窗口B 同基准后到 → conflict', !rB.ok && (rB as any).reason === 'conflict')
const sB = (rB as any).state
const cfl = sB.conflicts[0]
check('冲突待办保留 B 的意图与基准', cfl.status === '待处理' && cfl.baseSeq === base && cfl.winnerSeq === sA.dispositionSeq && cfl.origin === 'WIN-B')
check('A 的 P3 变更未被覆盖', sB.processSteps.find((x: any) => x.id === 'P3').limit === 'Fe 1.2 mm / SUS 1.8 mm')
check('B 的 P4 意图未落到业务数据', sB.processSteps.find((x: any) => x.id === 'P4').limit === '0.38-0.45 MPa')
check('冲突本身占一个版本且有审计', sB.versions[0].kind === '冲突登记' && sB.audit.some((a: any) => a.action === '并发冲突待办'))

/* 续提：B 变基到最新版本重做 */
const rCont = resolveConflict(sB, cfl.id, 'continue', { origin: 'WIN-B', operator: '窗口B' })
check('续提成功', rCont.ok); const sC = (rCont as any).state
check('续提后 P4 落新版本', sC.processSteps.find((x: any) => x.id === 'P4').limit === '0.40-0.46 MPa')
check('P3 的 A 版本仍在', sC.processSteps.find((x: any) => x.id === 'P3').limit === 'Fe 1.2 mm / SUS 1.8 mm')
check('冲突标记为已续提并关联版本', sC.conflicts[0].status === '已续提' && sC.conflicts[0].resolvedSeq === sC.dispositionSeq)

/* 放弃路径 */
let s2 = migrate(null)
const b0 = s2.dispositionSeq
const a1 = buildCommit(s2, { type: 'matrixChange', stepId: 'P1', limit: '≤ 3 ℃', frequency: s2.processSteps[0].frequency, correctiveAction: s2.processSteps[0].correctiveAction }, b0, { origin: 'A', operator: 'a' })
s2 = (a1 as any).state
const b1 = buildCommit(s2, { type: 'matrixChange', stepId: 'P2', limit: '≥ 75 ℃ / 15 s', frequency: s2.processSteps[1].frequency, correctiveAction: s2.processSteps[1].correctiveAction }, b0, { origin: 'B', operator: 'b' })
s2 = (b1 as any).state
const cfl2 = s2.conflicts[0]
const ab = resolveConflict(s2, cfl2.id, 'abandon', { origin: 'B', operator: 'b' })
check('放弃成功', ab.ok); s2 = (ab as any).state
check('放弃后 B 意图不落库', s2.processSteps[1].limit === '≥ 72 ℃ / 15 s')
check('放弃后 A 版本保持', s2.processSteps[0].limit === '≤ 3 ℃')

/* 5. 原子性：所有审计条目都能对应一个已存在版本（无半套审计） */
console.log('\n[5] 版本原子性')
const seqSet = new Set(sC.versions.map((v: any) => v.seq))
check('每条审计都归属存在的处置版本', sC.audit.every((a: any) => seqSet.has(a.dispositionSeq)))
check('版本号严格连续 1..N', sC.versions.every((v: any, i: number) => v.seq === sC.dispositionSeq - i))
check('不存在 seq 空洞', sC.dispositionSeq === sC.versions.length)
// 失败的校验不产生任何版本/审计
const auditCount = sC.audit.length
const bad = buildCommit(sC, { type: 'matrixChange', stepId: 'P5', limit: '', frequency: 'x', correctiveAction: '' }, sC.dispositionSeq, c(sC))
check('非法提交无版本无审计（引用相等）', !bad.ok && (bad as any).state === sC && sC.audit.length === auditCount)

/* 6. 模拟 WAL 恢复：基于 V(n) 的日志，在 V(n) 快照上重做 = 接着最后完整版本 */
console.log('\n[6] WAL 恢复语义')
const snapBase = sA.dispositionSeq
const replay = buildCommit(sA, { type: 'matrixChange', stepId: 'P4', limit: '0.40-0.46 MPa', frequency: sA.processSteps.find((x: any) => x.id === 'P4').frequency, correctiveAction: sA.processSteps.find((x: any) => x.id === 'P4').correctiveAction }, snapBase, { origin: 'WIN-B', operator: '窗口B' })
check('恢复重做：基准未变时直接成为新版本', replay.ok)
const replay2 = buildCommit(sC, { type: 'matrixChange', stepId: 'P5', limit: '≤ 8 ℃ / 2 h', frequency: sC.processSteps.find((x: any) => x.id === 'P5').frequency, correctiveAction: sC.processSteps.find((x: any) => x.id === 'P5').correctiveAction }, snapBase, { origin: 'WIN-B', operator: '窗口B' })
check('恢复重做：期间对方已推进 → 转冲突待办而非覆盖', !replay2.ok && (replay2 as any).reason === 'conflict')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
