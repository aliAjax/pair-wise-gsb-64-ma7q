import { useState } from 'react'
import { Badge, Button, Field, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { previewMatrixImpact, updateProcessStep } from '../store/haccpSlice'
import type { ProcessStep } from '../types'

export function ProcessControl() {
  const dispatch = useDispatch<AppDispatch>()
  const doc = useSelector((root: RootState) => root.haccp)
  const steps = doc.processSteps
  const [editing, setEditing] = useState<ProcessStep | null>(null)
  const [baseVersion, setBaseVersion] = useState(0)

  const startEdit = (step: ProcessStep) => {
    setEditing(structuredClone(step))
    setBaseVersion(doc.planVersion)
  }

  const save = () => {
    if (editing) {
      dispatch(updateProcessStep({ step: editing, operator: '质量主管 周衡' }))
      setEditing(null)
    }
  }

  const preview = editing ? previewMatrixImpact(doc, editing.id) : []
  const affected = preview.filter((item) => !item.signed)
  const frozen = preview.filter((item) => item.signed)
  const previous = editing ? steps.find((step) => step.id === editing.id) : undefined
  const criticalChanged = editing && previous
    ? (editing.limit !== previous.limit || editing.correctiveAction !== previous.correctiveAction)
    : false

  return (
    <section className="page">
      <header className="page-head">
        <div><p>危害分析 / 关键控制点</p><h1>HACCP控制矩阵</h1></div>
        <span className="sync-state">当前矩阵版本 V{doc.planVersion}（批次列表 / 偏差工作台 / 追溯审计同源显示）</span>
      </header>
      <div className="process-flow">{steps.map((step, index) => <div key={step.id}><b>{index + 1}</b><span>{step.name}</span><small>{step.equipment}</small></div>)}</div>
      <div className="table-panel">
        <Table size="small">
          <TableHeader><TableRow><TableHeaderCell>步骤</TableHeaderCell><TableHeaderCell>潜在危害</TableHeaderCell><TableHeaderCell>控制点</TableHeaderCell><TableHeaderCell>关键限值</TableHeaderCell><TableHeaderCell>监控频率</TableHeaderCell><TableHeaderCell>纠偏措施</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
          <TableBody>{steps.map((step) => <TableRow key={step.id}><TableCell>{step.name}</TableCell><TableCell>{step.hazard}</TableCell><TableCell>{step.controlPoint}</TableCell><TableCell><strong>{step.limit}</strong></TableCell><TableCell>{step.frequency}</TableCell><TableCell>{step.correctiveAction}</TableCell><TableCell><Button size="small" appearance="subtle" onClick={() => startEdit(step)}>编辑</Button></TableCell></TableRow>)}</TableBody>
        </Table>
      </div>
      {editing && <div className="edit-panel">
        <h3>{editing.name} · 控制参数{baseVersion !== doc.planVersion && <Badge appearance="tint" color="severe" style={{ marginLeft: 8 }}>另一窗口已提交到V{doc.planVersion}，保存时自动基于最新版处理</Badge>}</h3>
        <div className="edit-grid">
          <Field label="关键限值"><Input value={editing.limit} onChange={(_, data) => setEditing({ ...editing, limit: data.value })} /></Field>
          <Field label="监控频率"><Input value={editing.frequency} onChange={(_, data) => setEditing({ ...editing, frequency: data.value })} /></Field>
          <Field label="纠偏措施"><Input value={editing.correctiveAction} onChange={(_, data) => setEditing({ ...editing, correctiveAction: data.value })} /></Field>
        </div>

        {criticalChanged && <div className="impact-preview">
          <h4>关键限值/纠偏措施变化的影响范围（保存即生成新矩阵版本V{doc.planVersion + 1}）</h4>
          {affected.length === 0 && frozen.length === 0 && <p>当前没有该控制点的未关闭偏差。</p>}
          {affected.length > 0 && <ul>
            {affected.map(({ deviation, batch }) => <li key={deviation.id}>
              <Badge appearance="tint" color="severe">等待重评</Badge>
              <strong>{deviation.id}</strong>（{batch?.id} · {deviation.title}）
              <span>证据保留为处置V{deviation.version}，追加等待重评版本，批次维持{batch?.status ?? '隔离'}：{deviation.impactScope}</span>
            </li>)}
          </ul>}
          {frozen.length > 0 && <ul>
            {frozen.map(({ deviation, batch }) => <li key={deviation.id}>
              <Badge appearance="tint" color="success">签字冻结</Badge>
              <strong>{deviation.id}</strong>（{batch?.id}）已随批次签字放行，本次改版不改写其状态、证据与签字，仅可追溯。
            </li>)}
          </ul>}
        </div>}

        <div className="record-actions"><Button onClick={() => setEditing(null)}>取消</Button><Button appearance="primary" disabled={!editing.limit || !editing.correctiveAction} onClick={save}>保存为新处置/矩阵版本并审计</Button></div>
      </div>}
      <div className="rule-band"><strong>控制矩阵约束</strong><span>关键限值或纠偏措施变化时，未关闭偏差保留证据并等待重评；已签字放行批次不改写；两窗口同时改版时后到一方进入冲突待办。</span></div>
    </section>
  )
}
