/* 存储与提交流程集成验证：localStorage 内存模拟 + 可注入写入故障 */
// ---- 最小浏览器环境垫片 ----
const memStore = new Map<string, string>()
const listeners: Array<(e: StorageEvent) => void> = []
;(globalThis as any).localStorage = {
  getItem: (k: string) => memStore.has(k) ? memStore.get(k)! : null,
  setItem: (k: string, v: string) => { memStore.set(k, String(v)) },
  removeItem: (k: string) => { memStore.delete(k) }
}
;(globalThis as any).window = {
  addEventListener: (_t: string, fn: (e: StorageEvent) => void) => listeners.push(fn),
  dispatchEvent: () => {}
}
;(globalThis as any).document = {}

import { configureStore } from '@reduxjs/toolkit'
import reducer, { bootstrap, commitIntent, recoverPending, resetDemo, resolveConflictThunk } from '../src/store/haccpSlice'
import { setWriteFault, windowId } from '../src/services/storage'
import type { HaccpState } from '../src/types'

const makeStore = () => configureStore({ reducer: { haccp: reducer } })
let passed = 0; let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name} ${detail}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* A. 首次启动迁移并持久化 */
console.log('\n[A] 启动迁移')
let store = makeStore()
await store.dispatch(bootstrap())
await sleep(0)
let h = store.getState().haccp as HaccpState
check('启动后为 V1 且已落盘', h.dispositionSeq === 1 && memStore.has('gsb64:haccp-platform'), `seq=${h.dispositionSeq}`)
check('无残留 WAL', !memStore.has(`gsb64:haccp-pending-v2:${windowId}`))

/* B. 正常提交 → 快照与版本链完整 */
console.log('\n[B] 正常原子提交')
let out = await store.dispatch(commitIntent({ intent: { type: 'matrixChange', stepId: 'P1', limit: '≤ 3 ℃', frequency: '每批', correctiveAction: '拒收并隔离供应商批次' } }))
check('提交结果 committed', (out as any).payload.status === 'committed')
h = store.getState().haccp as HaccpState
const snapV2 = JSON.parse(memStore.get('gsb64:haccp-platform')!) as HaccpState
check('快照同步到 V2', h.dispositionSeq === 2 && snapV2.dispositionSeq === 2)
check('快照含该版本与审计', snapV2.versions[0].kind === '矩阵变更' && snapV2.audit[0].dispositionSeq === 2)
check('WAL 已清理', !memStore.has(`gsb64:haccp-pending-v2:${windowId}`))

/* C. 写入故障：提交不半套，WAL 保留；“重新打开”可恢复 */
console.log('\n[C] 写入故障与恢复')
setWriteFault(true)
out = await store.dispatch(commitIntent({ intent: { type: 'matrixChange', stepId: 'P2', limit: '≥ 74 ℃ / 15 s', frequency: '连续记录', correctiveAction: '自动回流并触发偏差' } }))
check('故障时返回 persist-failed', (out as any).payload.status === 'persist-failed')
h = store.getState().haccp as HaccpState
check('内存已到 V3 供继续操作', h.dispositionSeq === 3)
check('磁盘仍是最后完整版本 V2（无半套）', JSON.parse(memStore.get('gsb64:haccp-platform')!).dispositionSeq === 2)
check('前写日志保留 V2 基准与意图', (() => {
  const wal = JSON.parse(memStore.get(`gsb64:haccp-pending-v2:${windowId}`)!)
  return wal.baseSeq === 2 && wal.intent.type === 'matrixChange' && wal.intent.stepId === 'P2'
})())

// 模拟“重新打开应用”：新 store 从磁盘加载（先看到 V2），bootstrap 触发恢复
setWriteFault(false)
const store2 = makeStore()
await store2.dispatch(bootstrap())
await sleep(0)
const h2 = store2.getState().haccp as HaccpState
check('重开后自动恢复到 V3', h2.dispositionSeq === 3 && h2.processSteps.find((x) => x.id === 'P2')!.limit === '≥ 74 ℃ / 15 s')
check('恢复后 WAL 已清理', !memStore.has(`gsb64:haccp-pending-v2:${windowId}`))
check('恢复后磁盘为完整 V3', JSON.parse(memStore.get('gsb64:haccp-platform')!).dispositionSeq === 3)
check('P2 变更按 V3 原子入账（无重复审计）', h2.audit.filter((a) => a.dispositionSeq === 3 && a.action === '修改控制矩阵').length === 1)

/* D. 手动恢复：故障期间连续操作后点“故障恢复” */
setWriteFault(true)
await store2.dispatch(commitIntent({ intent: { type: 'matrixChange', stepId: 'P3', limit: 'Fe 1.2 mm / SUS 1.8 mm', frequency: '每半小时', correctiveAction: '隔离末次合格点以来产品' } }))
setWriteFault(false)
// 此时磁盘仍是 V3，内存是 V4；手动恢复：磁盘 V3 与 WAL 重做
const rec = await store2.dispatch(recoverPending())
check('手动恢复报告成功', (rec as any).payload.report.includes('V4'))
const h3 = store2.getState().haccp as HaccpState
check('恢复后到达 V4', h3.dispositionSeq === 4 && h3.processSteps.find((x) => x.id === 'P3')!.limit === 'Fe 1.2 mm / SUS 1.8 mm')

/* E. 并发：旧基准提交 → 冲突待办（持久化）；续提与放弃 */
console.log('\n[E] 冲突持久化与决议')
const seqBefore = h3.dispositionSeq
const baseV4 = seqBefore
// 对方先提交（P4 有未关闭 seed 偏差，会联动待重评，占用一个版本）
let o = await store2.dispatch(commitIntent({ intent: { type: 'matrixChange', stepId: 'P4', limit: '0.40-0.46 MPa', frequency: '每小时', correctiveAction: '停机调机并复检留样' } }))
check('对方提交 committed', (o as any).payload.status === 'committed')
const seqWinner = (store2.getState().haccp as HaccpState).dispositionSeq
check('对方版本联动 P4 未关闭偏差转待重评', (store2.getState().haccp as HaccpState).deviations.some((d) => d.stepId === 'P4' && d.status === '待重评'))
// 本方仍持旧基准
o = await store2.dispatch(commitIntent({ baseSeq: baseV4, intent: { type: 'matrixChange', stepId: 'P5', limit: '≤ 8 ℃ / 2 h', frequency: '每批', correctiveAction: '延长冷却并观察质量' } }))
check('后到方返回 conflict', (o as any).payload.status === 'conflict')
let h4 = store2.getState().haccp as HaccpState
check('冲突待办持久化在快照中', JSON.parse(memStore.get('gsb64:haccp-platform')!).conflicts.length >= 1)
const cfl = h4.conflicts[0]
check('冲突意图与版本号完整', cfl.baseSeq === baseV4 && cfl.winnerSeq === seqWinner && cfl.status === '待处理')

o = await store2.dispatch(resolveConflictThunk({ conflictId: cfl.id, action: 'continue' }))
check('续提 committed', (o as any).payload.status === 'committed')
h4 = store2.getState().haccp as HaccpState
check('续提后 P5 落新版本且 P4 的对方版本保留', h4.processSteps.find((x) => x.id === 'P5')!.limit === '≤ 8 ℃ / 2 h'
  && h4.processSteps.find((x) => x.id === 'P4')!.limit === '0.40-0.46 MPa')
check('冲突记录标记已续提并关联新版本', h4.conflicts[0].status === '已续提' && h4.conflicts[0].resolvedSeq === h4.dispositionSeq)
check('续提不覆盖对方的待重评联动', h4.deviations.some((d) => d.stepId === 'P4' && d.status === '待重评'))

/* F. 校验失败不留痕 */
console.log('\n[F] 失败安全')
const before = store2.getState().haccp as HaccpState
const audits = before.audit.length
o = await store2.dispatch(commitIntent({ intent: { type: 'matrixChange', stepId: 'P5', limit: '', frequency: '', correctiveAction: '' } }))
check('空限值被拦截', (o as any).payload.status === 'invalid')
const after = store2.getState().haccp as HaccpState
check('拦截后版本与审计无变化', after.dispositionSeq === before.dispositionSeq && after.audit.length === audits)
check('拦截后无 WAL 残留', !memStore.has(`gsb64:haccp-pending-v2:${windowId}`))

/* G. 重置演示数据 */
await store2.dispatch(resetDemo())
const hr = store2.getState().haccp as HaccpState
check('重置回到 V1 基线', hr.dispositionSeq === 1 && hr.conflicts.length === 0 && JSON.parse(memStore.get('gsb64:haccp-platform')!).dispositionSeq === 1)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) process.exit(1)
