import { useState } from 'react'
import { Button, Field, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'
import type { ProcessStep } from '../types'
import { useCommit } from '../hooks/useCommit'
import { NoticeBar, VersionStamp } from '../components/VersionStamp'

export function ProcessControl() {
  const steps = useSelector((root: RootState) => root.haccp.processSteps)
  const currentSeq = useSelector((root: RootState) => root.haccp.dispositionSeq)
  const deviations = useSelector((root: RootState) => root.haccp.deviations)
  const batches = useSelector((root: RootState) => root.haccp.batches)
  const [editing, setEditing] = useState<ProcessStep | null>(null)
  // 进入编辑瞬间记录基准版本：另一窗口若已先提交，保存时即触发冲突待办
  const [baseSeq, setBaseSeq] = useState(currentSeq)
  const { submit, notice, busy } = useCommit()

  const startEdit = (step: ProcessStep) => { setEditing(structuredClone(step)); setBaseSeq(currentSeq) }
  const save = async () => {
    if (!editing) return
    await submit(
      { type: 'matrixChange', stepId: editing.id, limit: editing.limit, frequency: editing.frequency, correctiveAction: editing.correctiveAction },
      baseSeq
    )
    setEditing(null)
  }

  const impactPreview = (step: ProcessStep) => {
    const open = deviations.filter((dev) => dev.stepId === step.id && dev.status !== '已关闭')
    const protectedBatches = open.filter((dev) => batches.find((b) => b.id === dev.batchId)?.release).length
    return { open, protectedBatches }
  }

  return (
    <section className="page">
      <header className="page-head"><div><p>危害分析 / 关键控制点 · 处置版本 V{currentSeq}</p><h1>HACCP控制矩阵</h1></div></header>
      <NoticeBar notice={notice} />
      <div className="process-flow">{steps.map((step, index) => <div key={step.id}><b>{index + 1}</b><span>{step.name}</span><small>{step.equipment} · V{step.dispositionSeq}</small></div>)}</div>
      <div className="table-panel">
        <Table size="small">
          <TableHeader><TableRow><TableHeaderCell>步骤</TableHeaderCell><TableHeaderCell>潜在危害</TableHeaderCell><TableHeaderCell>控制点</TableHeaderCell><TableHeaderCell>关键限值</TableHeaderCell><TableHeaderCell>纠偏措施</TableHeaderCell><TableHeaderCell>监控频率</TableHeaderCell><TableHeaderCell>未关闭偏差</TableHeaderCell><TableHeaderCell>处置版本</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
          <TableBody>{steps.map((step) => {
            const impact = impactPreview(step)
            return <TableRow key={step.id}><TableCell>{step.name}</TableCell><TableCell>{step.hazard}</TableCell><TableCell>{step.controlPoint}</TableCell><TableCell><strong>{step.limit}</strong></TableCell><TableCell>{step.correctiveAction}</TableCell><TableCell>{step.frequency}</TableCell>
              <TableCell>{impact.open.length > 0 ? <span className="impact-hot">{impact.open.length} 项{impact.protectedBatches > 0 ? `（${impact.protectedBatches} 批已签字冻结）` : ''}</span> : <span className="impact-none">无</span>}</TableCell>
              <TableCell><VersionStamp seq={step.dispositionSeq} /></TableCell>
              <TableCell><Button size="small" appearance="subtle" onClick={() => startEdit(step)}>编辑</Button></TableCell></TableRow>
          })}</TableBody>
        </Table>
      </div>
      {editing && <div className="edit-panel">
        <h3>{editing.name} · 控制参数（基于 V{baseSeq} 编辑）</h3>
        <div className="edit-grid">
          <Field label="关键限值（变更将冻结未关闭偏差证据并触发重评）"><Input value={editing.limit} onChange={(_, data) => setEditing({ ...editing, limit: data.value })} /></Field>
          <Field label="监控频率（仅频率变更不触发重评）"><Input value={editing.frequency} onChange={(_, data) => setEditing({ ...editing, frequency: data.value })} /></Field>
          <Field label="纠偏措施（变更将冻结未关闭偏差证据并触发重评）"><Input value={editing.correctiveAction} onChange={(_, data) => setEditing({ ...editing, correctiveAction: data.value })} /></Field>
        </div>
        {(() => {
          const affected = deviations.filter((dev) => dev.stepId === editing.id && dev.status !== '已关闭')
          const frozen = affected.filter((dev) => batches.find((b) => b.id === dev.batchId)?.release)
          const willReassess = affected.length - frozen.length
          return <div className="impact-preview">
            {willReassess > 0 && <p>保存后 {willReassess} 项未关闭偏差将<strong>保留既有证据</strong>并转入“待重评”，关联未放行批次维持隔离。</p>}
            {frozen.length > 0 && <p>{frozen.length} 个已签字放行批次按其签字版本<strong>冻结，不被本次改写</strong>。</p>}
            {affected.length === 0 && <p>该控制点下无未关闭偏差；如无实质变更将被拦截。</p>}
          </div>
        })()}
        <div className="record-actions"><Button disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button appearance="primary" disabled={busy || !editing.limit || !editing.correctiveAction} onClick={save}>提交处置版本</Button></div>
      </div>}
      <div className="rule-band"><strong>控制矩阵约束</strong><span>关键限值或纠偏措施变更按新版本原子提交：偏差证据冻结待重评、已放行批次不被改写；并发提交后进冲突待办。</span></div>
    </section>
  )
}
