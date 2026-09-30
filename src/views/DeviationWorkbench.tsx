import { useMemo, useState } from 'react'
import { Badge, Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { activeDisposition, createDeviation, reevaluateDeviation, resolveConflict, reviewDeviation, saveInvestigation } from '../store/haccpSlice'
import type { ConflictTodo, DecisionType, Deviation, DispositionVersion, Investigation } from '../types'

const statusColorForDisposition = (status: DispositionVersion['status']) =>
  status === '已完成' ? 'success' : status === '等待重评' ? 'severe' : status === '冲突待办' ? 'danger' : status === '待复核' ? 'important' : 'warning'

const kindLabel: Record<DispositionVersion['kind'], string> = {
  '登记': '偏差登记',
  '调查': '调查提交',
  '重评': '矩阵改版重评',
  '复核': '复核签字'
}

function VersionTimeline({ deviation }: { deviation: Deviation }) {
  return <div className="timeline">
    {deviation.dispositions.map((disp) => <div key={`${deviation.id}-v${disp.version}-${disp.createdAt}`} className={`timeline-item ${disp.status === '冲突待办' ? 'conflict' : ''}`}>
      <div className="timeline-dot">V{disp.version}</div>
      <div className="timeline-body">
        <header>
          <strong>{kindLabel[disp.kind]}</strong>
          <Badge appearance="tint" color={statusColorForDisposition(disp.status)}>{disp.status}</Badge>
          <small>{disp.operator} · {disp.createdAt.replace('T', ' ').slice(0, 16)} · 基于矩阵V{disp.basedOnPlanVersion}</small>
        </header>
        <p>{disp.note}</p>
        {disp.investigation.evidence && <p className="evidence-line">证据：{disp.investigation.evidence}</p>}
        {disp.impactScope && <small>影响范围：{disp.impactScope}</small>}
        {disp.status === '冲突待办' && !disp.conflictResolved && <small className="conflict-note">与V{disp.conflictsWithVersion}并发，证据/签字已原样保留，请到下方“冲突待办”处理（重放或留档）。</small>}
        {disp.conflictResolved && <small className="conflict-resolved">冲突已{disp.resolution === '已重放' ? '重放' : '留档'}（{disp.resolvedBy} · {disp.resolvedAt?.replace('T', ' ').slice(0, 16)}）</small>}
      </div>
    </div>)}
  </div>
}

function ConflictInbox() {
  const dispatch = useDispatch<AppDispatch>()
  const doc = useSelector((root: RootState) => root.haccp)
  const items = doc.conflictInbox.filter((item) => item.status === '待处理')
  if (items.length === 0) return null

  const describe = (item: ConflictTodo) => {
    switch (item.kind) {
      case '调查提交':
      case '重评':
        return '后到一方的调查/重评内容未覆盖先到证据，可基于最新版重放为新版本，或留档备查。'
      case '复核签字':
        return '先到一方签字已生效；后到签字未覆盖，可在最新版基础上重放或留档。'
      case '放行签字':
        return '批次已由对方签字冻结；通常留档，仅当批次仍可放行时允许重放。'
      case '矩阵改版':
        return '对方改版已生效；可将本窗口参数基于最新版重放，请先核对受影响偏差。'
    }
  }

  return <div className="conflict-inbox">
    <h3>冲突待办（{items.length}）— 后到提交未覆盖对方证据或签字</h3>
    {items.map((item) => <div key={item.id} className="conflict-card">
      <header>
        <Badge appearance="tint" color="danger">{item.kind}</Badge>
        <strong>{item.summary}</strong>
        <small>{item.id} · 窗口{item.windowId} · {item.operator} · {item.createdAt.replace('T', ' ').slice(0, 16)}</small>
      </header>
      <p>{describe(item)}</p>
      <div className="record-actions">
        <Button size="small" appearance="primary" onClick={() => dispatch(resolveConflict({ inboxId: item.id, resolution: 'replay', operator: '质量负责人 秦岚' }))}>重放（基于最新版再提交）</Button>
        <Button size="small" onClick={() => dispatch(resolveConflict({ inboxId: item.id, resolution: 'archive', operator: '质量负责人 秦岚' }))}>留档备查</Button>
      </div>
    </div>)}
  </div>
}

export function DeviationWorkbench() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const [status, setStatus] = useState<Deviation['status'] | '全部'>('全部')
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const [showCreate, setShowCreate] = useState(false)
  const [newDeviation, setNewDeviation] = useState({ batchId: state.batches[0]?.id ?? '', stepId: state.processSteps[0]?.id ?? '', title: '', severity: '一般' as const, owner: '质量工程组' })
  const rows = useMemo(() => state.deviations.filter((item) => status === '全部' || item.status === status), [state.deviations, status])
  const selected = state.deviations.find((item) => item.id === selectedId) ?? rows[0]
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const [reevalNote, setReevalNote] = useState('')
  const activeInvestigation = investigation?.cause === selected?.investigation.cause ? investigation : selected?.investigation

  const active = selected ? activeDisposition(selected) : undefined
  const waitingConflict = selected?.dispositions.some((item) => item.status === '冲突待办' && !item.conflictResolved)

  return (
    <section className="page">
      <header className="page-head">
        <div><p>关键限值偏离 / 调查与复核</p><h1>偏差处置工作台</h1></div>
        <Button appearance="primary" onClick={() => setShowCreate(true)}>登记偏差</Button>
      </header>
      <div className="toolbar">
        <Dropdown value={status} selectedOptions={[status]} onOptionSelect={(_, data) => setStatus(data.optionValue as typeof status)}>{['全部', '待调查', '调查中', '待复核', '已关闭'].map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown>
        <span>同一处置版本两窗口并发时，后到一方进入冲突待办；处置版本与控制矩阵V{state.planVersion}一致。</span>
      </div>
      <ConflictInbox />
      <div className="split-layout workbench-layout">
        <div className="deviation-list">{rows.map((item) => {
          const summary = activeDisposition(item)
          return <button key={item.id} className={item.id === selected?.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setInvestigation(null); setReevalNote('') }}>
            <div><Badge color={item.severity === '重大' ? 'danger' : 'warning'}>{item.severity}</Badge><small>{item.id}</small></div>
            <strong>{item.title}</strong>
            <span>{item.batchId} · {item.owner}</span>
            <footer>
              <Badge appearance="tint" color={summary?.status === '等待重评' ? 'severe' : summary?.status === '冲突待办' ? 'danger' : undefined}>{summary?.status ?? item.status} V{item.version}</Badge>
              <span>{item.dueDate} 截止</span>
            </footer>
          </button>
        })}</div>
        {selected && <div className="record-panel">
          <div className="record-title">
            <div><span>{selected.id} · 当前处置版本 V{selected.version}（控制矩阵V{state.planVersion}）</span><h2>{selected.title}</h2></div>
            <Badge color={selected.severity === '重大' ? 'danger' : 'warning'}>{selected.status}</Badge>
          </div>

          {selected.pendingReeval && <div className="validation-text reeval-band">
            {selected.reevalReason}。该偏差在控制矩阵关键限值/纠偏措施变化后需重评：此前各版本证据（含{active?.evidenceRef || '调查证据'}）原样保留，批次保持隔离。请补充重评结论后提交，进入重新复核。
          </div>}
          {waitingConflict && <div className="validation-text conflict-band">该偏差存在未处理的冲突待办，先处理冲突再继续处置，避免覆盖对方证据。</div>}

          <Field label="原因判断"><Textarea value={activeInvestigation?.cause ?? ''} disabled={selected.pendingReeval || selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), cause: data.value })} /></Field>
          <Field label="证据摘要（不可覆盖，仅追加版本）"><Textarea value={activeInvestigation?.evidence ?? ''} disabled={selected.pendingReeval || selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), evidence: data.value })} /></Field>
          <Field label="处置分支"><Dropdown value={activeInvestigation?.decision} disabled={selected.pendingReeval || selected.status === '已关闭'} selectedOptions={[activeInvestigation?.decision ?? '返工']} onOptionSelect={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), decision: data.optionValue as DecisionType })}>{['返工', '报废', '让步接收'].map((item) => <Option key={item} value={item} text={item}>{item}</Option>)}</Dropdown></Field>
          <Field label="返工或报废指令"><Textarea value={activeInvestigation?.reworkInstruction ?? ''} disabled={selected.pendingReeval || selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), reworkInstruction: data.value })} /></Field>
          <Field label="影响范围"><Input value={selected.impactScope} readOnly /></Field>

          {!selected.pendingReeval && <div className="record-actions">
            <Button disabled={!activeInvestigation?.cause || !activeInvestigation?.evidence || selected.status === '已关闭'} onClick={() => dispatch(saveInvestigation({ id: selected.id, investigation: activeInvestigation!, operator: selected.owner }))}>提交调查（新增处置版本）</Button>
            <Button appearance="primary" disabled={selected.status !== '待复核'} onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: true, note: '调查证据充分，纠偏措施可执行。', reviewer: '质量负责人 秦岚' }))}>复核通过签字</Button>
            <Button appearance="subtle" disabled={selected.status !== '待复核'} onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: false, note: '需补充设备故障诊断记录。', reviewer: '质量负责人 秦岚' }))}>退回补充证据</Button>
          </div>}

          {selected.pendingReeval && <div className="reeval-block">
            <Field label="重评结论（矩阵新版下的判定）"><Textarea value={reevalNote} onChange={(_, data) => setReevalNote(data.value)} placeholder="例如：新限值下隔离范围不变，返工方案仍有效，证据沿用并补充XX记录。" /></Field>
            <div className="record-actions">
              <Button appearance="primary" disabled={!reevalNote.trim()} onClick={() => dispatch(reevaluateDeviation({ id: selected.id, investigation: activeInvestigation!, note: reevalNote, reviewer: '质量负责人 秦岚' }))}>完成重评并送复核</Button>
            </div>
          </div>}

          <h3 className="timeline-title">处置版本链（不可改写）</h3>
          <VersionTimeline deviation={selected} />
        </div>}
      </div>
      {showCreate && <div className="edit-panel">
        <h3>登记关键限值偏差</h3>
        <div className="edit-grid">
          <Field label="批次"><Dropdown value={newDeviation.batchId} selectedOptions={[newDeviation.batchId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, batchId: data.optionValue ?? '' })}>{state.batches.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.product}`}>{item.id} {item.product}</Option>)}</Dropdown></Field>
          <Field label="控制点"><Dropdown value={newDeviation.stepId} selectedOptions={[newDeviation.stepId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, stepId: data.optionValue ?? '' })}>{state.processSteps.map((item) => <Option key={item.id} value={item.id} text={item.name}>{item.name}</Option>)}</Dropdown></Field>
          <Field label="偏差标题"><Input value={newDeviation.title} onChange={(_, data) => setNewDeviation({ ...newDeviation, title: data.value })} /></Field>
        </div>
        <div className="record-actions"><Button onClick={() => setShowCreate(false)}>取消</Button><Button appearance="primary" disabled={!newDeviation.title || !newDeviation.batchId} onClick={() => { dispatch(createDeviation(newDeviation)); setShowCreate(false) }}>创建并隔离批次（处置V1）</Button></div>
      </div>}
    </section>
  )
}
