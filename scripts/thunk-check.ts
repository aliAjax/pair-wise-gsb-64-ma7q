/* 双窗口 thunk 集成校验：两个独立 Redux store 共享同一 localStorage。 */
import { configureStore } from '@reduxjs/toolkit'
import haccpReducer, {
  hydrateDoc, reevaluateDeviation, resolveConflict, reviewDeviation,
  saveInvestigation, signBatchRelease, updateBatchStatus, updateProcessStep
} from '../src/store/haccpSlice'
import { bootstrapPlan, STORAGE_KEY } from '../src/services/planSync'

let passed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { console.error(`✗ ${name} ${detail}`); process.exitCode = 1 }
  else { passed += 1; console.log(`✓ ${name}`) }
}

function makeMemory(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size }
  } as Storage
}

const ls = makeMemory()
;(globalThis as any).localStorage = ls
;(globalThis as any).sessionStorage = makeMemory()
bootstrapPlan()

type RootState = { haccp: State }
const makeStore = (preloaded?: RootState) => configureStore({
  reducer: { haccp: haccpReducer as unknown as (s: State | undefined, a: unknown) => State },
  preloadedState: preloaded,
  middleware: (getDefault) => getDefault({ serializableCheck: false })
})

const storeA = makeStore()
// 窗口B：以同一快照打开（独立 state 对象，模拟第二个浏览器窗口）
const storeB = makeStore({ haccp: JSON.parse(JSON.stringify(storeA.getState().haccp)) as State })
const h = (s: ReturnType<typeof makeStore>) => s.getState().haccp
const readDoc = () => JSON.parse(ls.getItem(STORAGE_KEY)!)

/* ---- 1. 两窗口同时提交 DEV-260929-01 的下一处置版本 ---- */
{
  const invA = { cause: 'A窗口原因', evidence: 'A窗口独有证据', decision: '返工' as const, reworkInstruction: 'A返工' }
  const invB = { cause: 'B窗口原因', evidence: 'B窗口独有证据', decision: '报废' as const, reworkInstruction: 'B报废' }

  const [ra, rb] = await Promise.all([
    storeA.dispatch(saveInvestigation({ id: 'DEV-260929-01', investigation: invA, operator: '窗口A-陈莉' }) as any).unwrap(),
    storeB.dispatch(saveInvestigation({ id: 'DEV-260929-01', investigation: invB, operator: '窗口B-杨鸣' }) as any).unwrap()
  ])

  check('A窗口提交成功', ra.kind === 'committed', ra.message)
  check('B窗口被判为冲突', rb.kind === 'conflict', rb.kind)

  const doc = readDoc()
  const dev = doc.deviations.find((d: any) => d.id === 'DEV-260929-01')
  const v4Live = dev.dispositions.find((x: any) => x.version === 4 && x.status !== '冲突待办')
  const v4Conflict = dev.dispositions.find((x: any) => x.version === 4 && x.status === '冲突待办')
  check('V4生效版本属于A窗口', v4Live.operator === '窗口A-陈莉' && v4Live.investigation.evidence === 'A窗口独有证据')
  check('B窗口证据原样保留在冲突待办', !!v4Conflict && v4Conflict.investigation.evidence === 'B窗口独有证据')
  check('冲突收件箱1条待处理', doc.conflictInbox.filter((i: any) => i.status === '待处理').length === 1)
  check('审计含冲突记录且标记窗口', doc.audit.some((a: any) => a.action === '冲突待办' && a.operator.includes('窗口B')))

  /* ---- 2. B窗口选择“重放”：基于最新版生成新版本，不覆盖A ---- */
  const inboxId = doc.conflictInbox.find((i: any) => i.status === '待处理').id
  const replay = await storeB.dispatch(resolveConflict({ inboxId, resolution: 'replay', operator: '质量负责人 秦岚' }) as any).unwrap()
  check('冲突重放成功', replay.kind === 'committed', replay.message)
  const doc2 = readDoc()
  const dev2 = doc2.deviations.find((d: any) => d.id === 'DEV-260929-01')
  const v4 = dev2.dispositions.find((x: any) => x.version === 4 && x.status !== '冲突待办')
  const v5 = dev2.dispositions.find((x: any) => x.version === 5)
  check('重放后A的V4仍然不变', v4.investigation.evidence === 'A窗口独有证据')
  check('重放生成V5且为B的证据', v5 && v5.status === '待复核' && v5.investigation.evidence === 'B窗口独有证据')
  check('冲突待办已标记重放', dev2.dispositions.find((x: any) => x.status === '冲突待办').conflictResolved === true)
}

/* ---- 3. 控制矩阵改版：未关闭偏差等待重评，已放行批次冻结 ---- */
{
  const steps = readDoc().processSteps
  const p2 = { ...steps.find((s: any) => s.id === 'P2'), limit: '≥ 75 ℃ / 20 s' }
  const r = await storeA.dispatch(updateProcessStep({ step: p2, operator: '质量主管 周衡' }) as any).unwrap()
  check('矩阵改版提交成功', r.kind === 'committed', r.message)
  const doc = readDoc()
  const dev = doc.deviations.find((d: any) => d.id === 'DEV-260929-01')
  check('改版后偏差等待重评', dev.pendingReeval === true && dev.dispositions.some((x: any) => x.status === '等待重评'))
  const waitVer = dev.dispositions.find((x: any) => x.status === '等待重评')
  check('等待重评版本保留原证据链', waitVer.investigation.evidence === 'B窗口独有证据')
  check('批次维持隔离', doc.batches.find((b: any) => b.id === 'B260929-01').status === '隔离中')
  check('已放行批次B260928-07未被改写', doc.batches.find((b: any) => b.id === 'B260928-07').status === '已放行')
  check('审计记录改版与影响范围', doc.audit.some((a: any) => a.action === '控制矩阵改版' && a.detail.includes('75')))

  // 等待重评期间普通调查提交应被阻止
  const blocked = await storeA.dispatch(saveInvestigation({
    id: 'DEV-260929-01',
    investigation: { cause: '强行提交', evidence: '不应被接受', decision: '返工', reworkInstruction: '' },
    operator: '窗口A-陈莉'
  }) as any).unwrap()
  check('等待重评期间普通提交被阻止', blocked.kind === 'blocked')

  /* ---- 4. 完成重评 → 回到待复核 → 复核关闭 ---- */
  const rr = await storeA.dispatch(reevaluateDeviation({
    id: 'DEV-260929-01',
    investigation: { cause: 'B窗口原因', evidence: 'B窗口独有证据；重评补充新限值验证记录', decision: '返工', reworkInstruction: '按75℃重新杀菌' },
    note: '新限值下返工方案仍有效，补充验证记录，维持返工。',
    reviewer: '质量负责人 秦岚'
  }) as any).unwrap()
  check('重评提交成功', rr.kind === 'committed', rr.message)
  const doc2 = readDoc()
  const dev2 = doc2.deviations.find((d: any) => d.id === 'DEV-260929-01')
  check('重评后解除等待', dev2.pendingReeval === false && dev2.status === '待复核')
  check('重评生成新版本(kind=重评)', dev2.dispositions.some((x: any) => x.kind === '重评' && x.status === '待复核'))

  const pass = await storeA.dispatch(reviewDeviation({ id: 'DEV-260929-01', approved: true, note: '重评依据充分，同意关闭。', reviewer: '质量负责人 秦岚' }) as any).unwrap()
  check('复核签字关闭成功', pass.kind === 'committed', pass.message)
  const doc3 = readDoc()
  const dev3 = doc3.deviations.find((d: any) => d.id === 'DEV-260929-01')
  check('偏差已关闭', dev3.status === '已关闭')
}

/* ---- 5. 写入失败：提示带重试，恢复后续接最后完整版本 ---- */
{
  const before = readDoc()
  const versionBefore = before.planVersion
  const auditBefore = before.audit.length

  const realSet = ls.setItem.bind(ls)
  let failOnce = true
  ls.setItem = (k: string, v: string) => {
    if (k === STORAGE_KEY && failOnce) { failOnce = false; throw new Error('模拟QuotaExceeded') }
    realSet(k, v)
  }

  const r = await storeA.dispatch(updateProcessStep({
    step: { ...readDoc().processSteps.find((s: any) => s.id === 'P1'), frequency: '每2小时' },
    operator: '质量主管 周衡'
  }) as any).unwrap()
  check('写入失败返回 write-failed', r.kind === 'write-failed')
  const afterFail = readDoc()
  check('失败后无半套版本', afterFail.planVersion === versionBefore && afterFail.audit.length === auditBefore)
  const notices = storeA.getState().haccp.notices
  check('失败提示带可重试动作', notices.length > 0 && !!notices[0].retry)

  // 模拟用户点“重试”
  ls.setItem = realSet
  const retry = await storeA.dispatch(updateProcessStep({
    step: { ...readDoc().processSteps.find((s: any) => s.id === 'P1'), frequency: '每2小时' },
    operator: '质量主管 周衡'
  }) as any).unwrap()
  check('重试成功续接下一完整版本', retry.kind === 'committed' && readDoc().planVersion === versionBefore + 1)
}

/* ---- 6. 两窗口同时签字放行：后到一方进冲突待办 ---- */
{
  // 准备：关闭 DEV-260929-02 并推进批次到可放行
  const d02 = readDoc().deviations.find((d: any) => d.id === 'DEV-260929-02')
  if (d02.status !== '已关闭') {
    const close = await storeA.dispatch(reviewDeviation({ id: 'DEV-260929-02', approved: true, note: '同意关闭', reviewer: '质量负责人 秦岚' }) as any).unwrap()
    if (close.kind !== 'committed') console.log('关闭DEV-02:', close.message)
  }
  let batch = readDoc().batches.find((x: any) => x.id === 'B260929-02')
  if (batch.status !== '可放行') {
    const toReady = await storeA.dispatch(updateBatchStatus({ id: 'B260929-02', status: '可放行', operator: '质量主管' }) as any).unwrap()
    if (toReady.kind !== 'committed') console.log('推进可放行:', toReady.message)
  }
  batch = readDoc().batches.find((x: any) => x.id === 'B260929-02')
  // 让窗口B同步到“可放行”的同一基线，然后两边同时签字
  storeB.dispatch(hydrateDoc(readDoc()))
  const [a, b] = await Promise.all([
    storeA.dispatch(signBatchRelease({ id: 'B260929-02', signer: '签字人A', note: 'A同意放行' }) as any).unwrap(),
    storeB.dispatch(signBatchRelease({ id: 'B260929-02', signer: '签字人B', note: 'B同意放行' }) as any).unwrap()
  ])
  check('签字A成功', a.kind === 'committed', a.message)
  check('签字B进入冲突待办', b.kind === 'conflict', `${b.kind} ${b.message}`)
  const doc = readDoc()
  const sigs = doc.signatures.filter((s: any) => s.batchId === 'B260929-02')
  check('只保留A的签字，B未覆盖', sigs.length === 1 && sigs[0].signer === '签字人A')
  check('批次已放行冻结', doc.batches.find((x: any) => x.id === 'B260929-02').status === '已放行')
  check('B的签字进入冲突收件箱', doc.conflictInbox.some((i: any) => i.kind === '放行签字' && i.status === '待处理'))

  // 再次对已冻结批次操作应被阻止
  const again = await storeB.dispatch(updateBatchStatus({ id: 'B260929-02', status: '隔离中', operator: '窗口B' }) as any).unwrap()
  check('已签字批次不可改写', again.kind === 'blocked')
}

console.log(`\n${passed} 项通过`)
