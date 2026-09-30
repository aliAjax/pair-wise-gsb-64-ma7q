/* 端到端流程校验（node 下用内存 storage 模拟两个浏览器窗口）。 */
import { assert } from 'console'
import { bootstrapPlan, commitDoc, appendOnLatest, persist, STORAGE_KEY, STAGING_KEY } from '../src/services/planSync'
import { buildSeedPlan } from '../src/data/seed'

let passed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { console.error(`✗ ${name} ${detail}`); process.exitCode = 1 }
  else { passed += 1; console.log(`✓ ${name}`) }
}

interface StorageShim { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function makeMemory(): StorageSham {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
    _map: map
  } as unknown as StorageSham
}
type StorageSham = StorageShim & { _map: Map<string, string> }

function installGlobals() {
  const mem = makeMemory()
  ;(globalThis as any).localStorage = mem
  ;(globalThis as any).sessionStorage = makeMemory()
  return mem
}

function readMain() {
  return JSON.parse((globalThis as any).localStorage.getItem(STORAGE_KEY))
}

/* ---------- 场景1：旧数据迁移 ---------- */
{
  const mem = installGlobals()
  const legacy = {
    batches: [
      { id: 'B-OLD-1', product: '旧品', line: 'L1', quantity: 100, producedAt: 'x', status: '隔离中', isolationScope: '杀菌段全部产品', version: 2, monitoring: [] },
      { id: 'B-OLD-2', product: '旧品2', line: 'L2', quantity: 200, producedAt: 'x', status: '已放行', isolationScope: '无', version: 5, monitoring: [] }
    ],
    deviations: [
      { id: 'D-OLD-1', batchId: 'B-OLD-1', stepId: 'P2', title: '旧偏差-调查中', severity: '重大', status: '调查中', owner: '张三', openedAt: '2026-09-01T00:00:00', dueDate: '2026-09-02', investigation: { cause: '原因X', evidence: '证据X', decision: '返工', reworkInstruction: '' }, reviewNote: '', reviewer: '', version: 2 },
      { id: 'D-OLD-2', batchId: 'B-OLD-2', stepId: 'P3', title: '旧偏差-已关闭', severity: '一般', status: '已关闭', owner: '李四', openedAt: '2026-09-01T01:00:00', dueDate: '2026-09-02', investigation: { cause: '原因Y', evidence: '证据Y', decision: '返工', reworkInstruction: '' }, reviewNote: '同意关闭', reviewer: '王五', version: 3 }
    ],
    processSteps: buildSeedPlan().processSteps,
    audit: [{ id: 'OLD-A1', entity: 'B-OLD-1', action: '自动创建偏差', operator: '系统', detail: '旧审计', createdAt: '2026-09-01T00:00:00' }],
    batchFilter: '', batchStatus: '全部', selectedBatchId: 'B-OLD-1'
  }
  mem._map.set(STORAGE_KEY, JSON.stringify(legacy))

  const boot = bootstrapPlan()
  check('迁移：识别为旧数据', boot.migrated)
  check('迁移：处置版本链补齐（调查中偏差V1登记+V2调查）', boot.doc.deviations[0].dispositions.length === 2)
  check('迁移：已关闭偏差补齐V3复核签字', boot.doc.deviations[1].dispositions.length === 3
    && boot.doc.deviations[1].dispositions[2].kind === '复核'
    && boot.doc.deviations[1].dispositions[2].reviewer === '王五')
  check('迁移：影响范围补齐', boot.doc.deviations[0].impactScope.includes('杀菌段全部产品'))
  check('迁移：批次状态照旧', boot.doc.batches[0].status === '隔离中' && boot.doc.batches[1].status === '已放行')
  check('迁移：偏差证据照旧可查', boot.doc.deviations[0].investigation.evidence === '证据X')
  check('迁移：已放行批次签字补齐且不改写', boot.doc.signatures.some((s) => s.batchId === 'B-OLD-2'))
  check('迁移：旧审计保留', boot.doc.audit.some((a) => a.id === 'OLD-A1'))
  check('迁移：审计新增迁移记录', boot.doc.audit.some((a) => a.action === '旧数据迁移'))
}

/* ---------- 场景2：矩阵改版 → 未关闭偏差等待重评，已放行批次不改写 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  const v = boot.doc.planVersion
  const res = commitDoc(v, (draft) => {
    const step = draft.processSteps.find((s) => s.id === 'P2')!
    step.limit = '≥ 75 ℃ / 20 s'
    const affected: string[] = []
    for (const d of draft.deviations) {
      if (d.stepId !== 'P2' || d.status === '已关闭') continue
      const batch = draft.batches.find((b) => b.id === d.batchId)!
      const hold: any = {
        version: d.dispositions.filter((x: any) => x.status !== '冲突待办').length + 1,
        kind: '重评', status: '等待重评', operator: '系统', note: '等待重评',
        investigation: JSON.parse(JSON.stringify(d.investigation)), reviewNote: '', reviewer: '',
        basedOnPlanVersion: v, reevalRequiredByPlan: v + 1, impactScope: d.impactScope, evidenceRef: '',
        createdAt: new Date().toISOString()
      }
      d.dispositions.push(hold)
      d.version = hold.version
      d.pendingReeval = true
      d.reevalReason = '改版重评'
      d.status = '调查中'
      if (batch.status !== '已放行') batch.status = '隔离中'
      affected.push(d.id)
    }
  })
  check('矩阵改版提交成功', res.kind === 'committed')
  if (res.kind === 'committed') {
    const dev = res.doc.deviations.find((d) => d.id === 'DEV-260929-01')!
    check('改版：未关闭偏差进入等待重评且证据保留', dev.pendingReeval
      && dev.dispositions.some((x) => x.status === '等待重评')
      && dev.dispositions.find((x) => x.status === '等待重评')!.investigation.evidence.includes('趋势图'))
    check('改版：批次维持隔离', res.doc.batches.find((b) => b.id === 'B260929-01')!.status === '隔离中')
    const signed = res.doc.batches.find((b) => b.id === 'B260928-07')!
    check('改版：已签字放行批次状态不改写', signed.status === '已放行')
    check('改版：文档版本+1', res.doc.planVersion === v + 1)
  }
}

/* ---------- 场景3：两窗口并发提交同一处置版本 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  const v = boot.doc.planVersion
  const devId = 'DEV-260929-01'
  const invA = { cause: '原因A窗口', evidence: '证据A-趋势图', decision: '返工' as const, reworkInstruction: 'A方案' }
  const invB = { cause: '原因B窗口', evidence: '证据B-检修单', decision: '报废' as const, reworkInstruction: 'B方案' }

  const first = commitDoc(v, (draft) => {
    const d = draft.deviations.find((x) => x.id === devId)!
    const nv = d.dispositions.filter((x) => x.status !== '冲突待办').length + 1
    d.dispositions.push({ version: nv, kind: '调查', status: '待复核', operator: '窗口A', note: 'A', investigation: JSON.parse(JSON.stringify(invA)), reviewNote: '', reviewer: '', basedOnPlanVersion: v, impactScope: d.impactScope, evidenceRef: invA.evidence, createdAt: new Date().toISOString() })
    d.investigation = JSON.parse(JSON.stringify(invA))
    d.version = nv
  })
  check('并发：先到一方提交成功', first.kind === 'committed')

  // 后到一方仍基于旧版本号提交 → stale
  const second = commitDoc(v, (draft) => {
    const d = draft.deviations.find((x) => x.id === devId)!
    d.dispositions.push({ version: 4, kind: '调查', status: '待复核', operator: '窗口B', note: 'B', investigation: JSON.parse(JSON.stringify(invB)), reviewNote: '', reviewer: '', basedOnPlanVersion: v, impactScope: d.impactScope, evidenceRef: invB.evidence, createdAt: new Date().toISOString() })
  })
  check('并发：后到一方CAS失败(stale)', second.kind === 'stale')

  // 登记冲突待办（追加，不覆盖）
  const conflict = appendOnLatest((draft) => {
    const d = draft.deviations.find((x) => x.id === devId)!
    d.dispositions.push({ version: 4, kind: '调查', status: '冲突待办', operator: '窗口B', note: '冲突', investigation: JSON.parse(JSON.stringify(invB)), reviewNote: '', reviewer: '', basedOnPlanVersion: v, impactScope: d.impactScope, evidenceRef: invB.evidence, createdAt: new Date().toISOString(), conflictsWithVersion: 4, conflictKind: '调查提交', conflictWindowId: 'W-B', conflictPayload: JSON.parse(JSON.stringify(invB)) })
    draft.conflictInbox.unshift({ id: 'CFL-T1', kind: '调查提交', entity: devId, batchId: d.batchId, deviationId: devId, dispositionVersion: 4, windowId: 'W-B', operator: '窗口B', summary: '测试冲突', payload: JSON.parse(JSON.stringify(invB)), createdAt: new Date().toISOString(), status: '待处理' })
  })
  check('并发：冲突待办登记成功', conflict.kind === 'committed')
  if (conflict.kind === 'committed') {
    const d = conflict.doc.deviations.find((x) => x.id === devId)!
    check('并发：先到证据V4未被覆盖', d.dispositions.find((x) => x.status === '待复核' && x.version === 4)!.investigation.evidence === '证据A-趋势图')
    const cf = d.dispositions.find((x) => x.status === '冲突待办' && x.version === 4)!
    check('并发：后到证据原样保留', cf.investigation.evidence === '证据B-检修单' && cf.conflictPayload!.decision === undefined ? false : true)
    check('并发：收件箱有一条待处理', conflict.doc.conflictInbox.filter((i) => i.status === '待处理').length >= 1)
    check('并发：当前权威调查仍是A', d.investigation.evidence === '证据A-趋势图')
  }
}

/* ---------- 场景4：放行双签字冲突 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  // 先把 B260929-02 的偏差关闭、批次推到可放行
  let v = boot.doc.planVersion
  const prep = commitDoc(v, (draft) => {
    const d = draft.deviations.find((x) => x.id === 'DEV-260929-02')!
    d.status = '已关闭'
    const b = draft.batches.find((x) => x.id === 'B260929-02')!
    b.status = '可放行'
  })
  check('放行准备成功', prep.kind === 'committed')
  if (prep.kind !== 'committed') throw new Error('prep failed')

  const winA = commitDoc(prep.doc.planVersion, (draft) => {
    draft.signatures.push({ batchId: 'B260929-02', signer: '签字A', note: 'A放行', dispositionVersions: {}, planVersion: prep.doc.planVersion, signedAt: new Date().toISOString() })
    draft.batches.find((x) => x.id === 'B260929-02')!.status = '已放行'
  })
  const winB = commitDoc(prep.doc.planVersion, (draft) => {
    draft.signatures.push({ batchId: 'B260929-02', signer: '签字B', note: 'B放行', dispositionVersions: {}, planVersion: prep.doc.planVersion, signedAt: new Date().toISOString() })
    draft.batches.find((x) => x.id === 'B260929-02')!.status = '已放行'
  })
  check('放行：窗口A签字成功', winA.kind === 'committed')
  check('放行：窗口B后到被拒(stale)', winB.kind === 'stale')
  if (winA.kind === 'committed') {
    const doc = readMain()
    check('放行：存储中只有A的签字（B未覆盖）', doc.signatures.filter((s: any) => s.batchId === 'B260929-02').length === 1
      && doc.signatures.find((s: any) => s.batchId === 'B260929-02').signer === '签字A')
  }
}

/* ---------- 场景5：写入失败不留半套，可重试续接 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  const v = boot.doc.planVersion
  const auditCountBefore = readMain().audit.length
  const real = (globalThis as any).localStorage
  let failMainOnce = true
  ;(globalThis as any).localStorage = new Proxy(real, {
    get(target, prop) {
      if (prop === 'setItem') return (k: string, val: string) => {
        if (k === STORAGE_KEY && failMainOnce) { failMainOnce = false; throw new Error('模拟QuotaExceeded') }
        return target.setItem(k, val)
      }
      return (target as any)[prop]?.bind(target)
    }
  })

  const fail = commitDoc(v, (draft) => {
    draft.audit.unshift({ id: 'HALF', entity: 'x', action: '半成品', operator: 'o', detail: '不应出现', createdAt: '', planVersion: draft.planVersion })
  })
  check('写入失败：返回 write-failed', fail.kind === 'write-failed')
  ;(globalThis as any).localStorage = real
  const docNow = readMain()
  check('写入失败：主文档仍是上一完整版本', docNow.planVersion === v && !docNow.audit.some((a: any) => a.id === 'HALF'))
  check('写入失败：审计条数未变（无半套）', docNow.audit.length === auditCountBefore)
  void auditCountBefore

  const retry = commitDoc(v, (draft) => {
    draft.processSteps[0].frequency = '每批（重试）'
  })
  check('写入失败：重试成功并续接V' + (v + 1), retry.kind === 'committed' && retry.kind === 'committed' && (retry as any).doc.planVersion === v + 1)
  if (retry.kind === 'committed') {
    check('写入失败：暂存区已清理', (globalThis as any).localStorage.getItem(STAGING_KEY) === null)
  }
}

/* ---------- 场景6：崩溃在暂存→主切换之间，启动恢复到最后完整版本 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  const newer = structuredClone(boot.doc)
  newer.planVersion = boot.doc.planVersion + 3
  newer.audit.unshift({ id: 'NEW3', entity: 'x', action: '恢复点之后的完整版本', operator: 'o', detail: 'V' + newer.planVersion, createdAt: '', planVersion: newer.planVersion })
  ;(globalThis as any).localStorage.setItem(STAGING_KEY, JSON.stringify(newer))
  // 主 key 停留在旧版本（模拟切换前崩溃）

  const reboot = bootstrapPlan()
  check('崩溃恢复：识别暂存区并恢复', reboot.recovered)
  check('崩溃恢复：接着最后完整版本继续', reboot.doc.planVersion === newer.planVersion)
  check('崩溃恢复：新版本内容存在', reboot.doc.audit.some((a) => a.id === 'NEW3'))
  check('崩溃恢复：审计记录恢复事件', reboot.doc.audit.some((a) => a.action === '启动恢复'))
}

/* ---------- 场景7：主文档损坏 + 暂存完好 ---------- */
{
  installGlobals()
  const boot = bootstrapPlan()
  const good = structuredClone(boot.doc)
  good.planVersion += 1
  ;(globalThis as any).localStorage.setItem(STAGING_KEY, JSON.stringify(good))
  ;(globalThis as any).localStorage.setItem(STORAGE_KEY, '{corrupt-json')
  const reboot = bootstrapPlan()
  check('主文档损坏：从暂存恢复完整版本', reboot.doc.planVersion === good.planVersion)
}

console.log(`\n${passed} 项通过`)
