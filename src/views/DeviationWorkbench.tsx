import { useMemo, useState } from 'react'
import { Badge, Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'
import { useCommit } from '../hooks/useCommit'
import type { DecisionType, Deviation, Investigation } from '../types'
import { NoticeBar, VersionStamp } from '../components/VersionStamp'

const statusFilters = ['全部', '待调查', '调查中', '待复核', '待重评', '已关闭'] as const
const statusColor = (status: Deviation['status']) => status === '已关闭' ? 'success' : status === '待重评' ? 'severe' : status === '待复核' ? 'important' : 'warning'

export function DeviationWorkbench() {
  const state = useSelector((root: RootState) => root.haccp)
  const [status, setStatus] = useState<Deviation['status'] | '全部'>('全部')
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const [showCreate, setShowCreate] = useState(false)
  const [newDeviation, setNewDeviation] = useState({ batchId: state.batches.find((b) => !b.release)?.id ?? state.batches[0]?.id ?? '', stepId: state.processSteps[0]?.id ?? '', title: '', severity: '一般' as const, owner: '质量工程组' })
  const rows = useMemo(() => state.deviations.filter((item) => status === '全部' || item.status === status), [state.deviations, status])
  const selected = state.deviations.find((item) => item.id === selectedId) ?? rows[0]
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const activeInvestigation: Investigation | undefined = investigation ?? selected?.investigation
  const { submit, notice, busy } = useCommit()

  const stepName = (id: string) => state.processSteps.find((item) => item.id === id)?.name ?? id
  const choose = (id: string) => { setSelectedId(id); setInvestigation(null) }

  return (
    <section className="page">
      <header className="page-head"><div><p>关键限值偏离 / 调查与复核 · 处置版本 V{state.dispositionSeq}</p><h1>偏差处置工作台</h1></div><Button appearance="primary" onClick={() => setShowCreate(true)}>登记偏差</Button></header>
      <NoticeBar notice={notice} />
      <div className="toolbar"><Dropdown value={status} selectedOptions={[status]} onOptionSelect={(_, data) => setStatus(data.optionValue as typeof status)}>{statusFilters.map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown><span>矩阵变更后未关闭偏差保留证据转“待重评”；复核签字版本与批次列表一致。</span></div>
      <div className="split-layout">
        <div className="deviation-list">{rows.map((item) => <button key={item.id} className={item.id === selected?.id ? 'active' : ''} onClick={() => choose(item.id)}>
          <div><Badge color={item.severity === '重大' ? 'danger' : 'warning'}>{item.severity}</Badge><small className="mono">{item.id} · V{item.dispositionSeq}</small></div>
          <strong>{item.title}</strong><span>{item.batchId} · {item.owner}</span><footer><Badge appearance="tint" color={statusColor(item.status) as 'warning'}>{item.status}</Badge><span>{item.dueDate} 截止</span></footer>
        </button>)}</div>
        {selected && <div className="record-panel">
          <div className="record-title"><div><span className="mono">{selected.id} · 处置版本 <VersionStamp seq={selected.dispositionSeq} /></span><h2>{selected.title}</h2></div><Badge color={statusColor(selected.status) as 'warning'}>{selected.status}</Badge></div>

          {selected.status === '待重评' && <div className="reassess-band">
            <strong>矩阵变更触发重评（自 V{selected.reassessFromSeq} → V{state.dispositionSeq}）</strong>
            <span>{selected.reassessReason}</span>
            <small>下方原因与证据为冻结快照，只能补充/修订后重新提交；原证据已在审计 V{selected.reassessFromSeq} 中留存。</small>
          </div>}

          <Field label={`原因判断${selected.status === '待重评' ? '（冻结快照，可在重评中修订）' : ''}`}><Textarea value={activeInvestigation?.cause ?? ''} disabled={selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), cause: data.value })} /></Field>
          <Field label={`证据摘要${selected.status === '待重评' ? '（保留，不得删除）' : ''}`}><Textarea value={activeInvestigation?.evidence ?? ''} disabled={selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), evidence: data.value })} /></Field>
          <Field label="处置分支"><Dropdown disabled={selected.status === '已关闭'} value={activeInvestigation?.decision} selectedOptions={[activeInvestigation?.decision ?? '返工']} onOptionSelect={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), decision: data.optionValue as DecisionType })}>{['返工', '报废', '让步接收'].map((item) => <Option key={item} value={item} text={item}>{item}</Option>)}</Dropdown></Field>
          <Field label="返工或报废指令"><Textarea value={activeInvestigation?.reworkInstruction ?? ''} disabled={selected.status === '已关闭'} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), reworkInstruction: data.value })} /></Field>

          {selected.reviewer && <div className="review-snapshot"><strong>上次复核：{selected.reviewer}</strong><span>{selected.reviewNote}</span></div>}

          <div className="record-actions">
            {selected.status !== '已关闭' && <Button disabled={busy || !activeInvestigation?.cause || !activeInvestigation?.evidence} onClick={() => { void submit({ type: 'investigationSave', deviationId: selected.id, investigation: activeInvestigation! }); setInvestigation(null) }}>{selected.status === '待重评' ? '按新矩阵重新提交（保留原证据）' : '提交调查'}</Button>}
            <Button appearance="primary" disabled={busy || selected.status !== '待复核'} onClick={() => void submit({ type: 'review', deviationId: selected.id, approved: true, note: '调查证据充分，纠偏措施可执行。' })}>复核通过并签字</Button>
          </div>
          {selected.status === '待复核' && <Button appearance="subtle" disabled={busy} onClick={() => void submit({ type: 'review', deviationId: selected.id, approved: false, note: '需补充设备故障诊断记录。' })}>退回补充证据</Button>}
          {selected.status === '待重评' && <p className="validation-text">控制点「{stepName(selected.stepId)}」的关键限值/纠偏措施已更新，本偏差须按 V{state.dispositionSeq} 重新评估后才能再次复核签字。</p>}
        </div>}
      </div>
      {showCreate && <div className="edit-panel">
        <h3>登记关键限值偏差</h3>
        <div className="edit-grid">
          <Field label="批次（已放行批次不可登记）"><Dropdown value={newDeviation.batchId} selectedOptions={[newDeviation.batchId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, batchId: data.optionValue ?? '' })}>{state.batches.filter((b) => !b.release).map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.product}`}>{item.id} {item.product}</Option>)}</Dropdown></Field>
          <Field label="控制点"><Dropdown value={newDeviation.stepId} selectedOptions={[newDeviation.stepId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, stepId: data.optionValue ?? '' })}>{state.processSteps.map((item) => <Option key={item.id} value={item.id} text={item.name}>{item.name}</Option>)}</Dropdown></Field>
          <Field label="偏差标题"><Input value={newDeviation.title} onChange={(_, data) => setNewDeviation({ ...newDeviation, title: data.value })} /></Field>
        </div>
        <div className="record-actions"><Button disabled={busy} onClick={() => setShowCreate(false)}>取消</Button><Button appearance="primary" disabled={busy || !newDeviation.title || !newDeviation.batchId} onClick={() => { void submit({ type: 'deviationCreate', ...newDeviation }); setShowCreate(false) }}>创建并隔离批次</Button></div>
      </div>}
    </section>
  )
}
