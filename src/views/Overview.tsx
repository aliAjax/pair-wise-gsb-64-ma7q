import { useMemo, useState, type ReactNode } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Dropdown, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea } from '@fluentui/react-components'
import type { AppDispatch, RootState } from '../store'
import { selectBatchDispositionSummary, setBatchFilter, setBatchStatus, setSelectedBatch, signBatchRelease, updateBatchStatus } from '../store/haccpSlice'
import type { BatchStatus } from '../types'

const statuses: Array<BatchStatus | '全部'> = ['全部', '生产中', '待复核', '可放行', '隔离中', '已放行', '已报废']
const statusColor = (status: BatchStatus) => status === '隔离中' || status === '已报废' ? 'danger' : status === '已放行' ? 'success' : status === '可放行' ? 'important' : 'warning'

export function Overview() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const [signNote, setSignNote] = useState('监测记录与偏差复核齐备，同意放行。')
  const rows = useMemo(() => state.batches.filter((batch) => {
    const text = `${batch.id} ${batch.product} ${batch.line}`.toLowerCase()
    return (!state.batchFilter || text.includes(state.batchFilter.toLowerCase())) && (state.batchStatus === '全部' || batch.status === state.batchStatus)
  }), [state.batches, state.batchFilter, state.batchStatus])
  const selected = state.batches.find((item) => item.id === state.selectedBatchId) ?? rows[0]
  const selectedDeviations = state.deviations.filter((item) => item.batchId === selected?.id)
  const openDeviations = selectedDeviations.filter((item) => item.status !== '已关闭' || item.pendingReeval)
  const signature = state.signatures.find((item) => item.batchId === selected?.id)
  const signed = !!signature

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <p>质量运营中心 / 批次控制</p>
          <h1>生产批次与放行</h1>
        </div>
        <span className="sync-state">处置版本基线：控制矩阵 V{state.planVersion} · 与偏差工作台、追溯审计同源</span>
      </header>

      <div className="metrics">
        <article><span>今日批次</span><strong>{state.batches.length}</strong><small>覆盖2条生产线</small></article>
        <article><span>隔离批次</span><strong>{state.batches.filter((item) => item.status === '隔离中').length}</strong><small>禁止放行</small></article>
        <article><span>未关闭/待重评偏差</span><strong>{state.deviations.filter((item) => item.status !== '已关闭' || item.pendingReeval).length}</strong><small>处置版本未闭合</small></article>
        <article><span>已放行（签字冻结）</span><strong>{state.signatures.length}</strong><small>矩阵改版不改写</small></article>
      </div>

      <div className="toolbar">
        <Input value={state.batchFilter} onChange={(_, data) => dispatch(setBatchFilter(data.value))} placeholder="搜索批次、产品、产线" />
        <Dropdown value={state.batchStatus} selectedOptions={[state.batchStatus]} onOptionSelect={(_, data) => dispatch(setBatchStatus(data.optionValue as BatchStatus | '全部'))}>
          {statuses.map((status) => <Option key={status} value={status}>{status}</Option>)}
        </Dropdown>
        <span>处置版本列为该批次各偏差当前完整处置版本，与工作台/审计一致</span>
      </div>

      <div className="split-layout">
        <div className="table-panel">
          <Table size="small" aria-label="生产批次">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>批次</TableHeaderCell>
                <TableHeaderCell>产品</TableHeaderCell>
                <TableHeaderCell>产线</TableHeaderCell>
                <TableHeaderCell>状态</TableHeaderCell>
                <TableHeaderCell>批次版本</TableHeaderCell>
                <TableHeaderCell>处置版本（控制矩阵V{state.planVersion}）</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((batch) => {
                const summary = selectBatchDispositionSummary(state, batch.id)
                return (
                  <TableRow key={batch.id} onClick={() => dispatch(setSelectedBatch(batch.id))} className={batch.id === selected?.id ? 'selected-row' : ''}>
                    <TableCell>{batch.id}</TableCell>
                    <TableCell>{batch.product}</TableCell>
                    <TableCell>{batch.line}</TableCell>
                    <TableCell><Badge appearance="tint" color={statusColor(batch.status)}>{batch.status}</Badge></TableCell>
                    <TableCell>V{batch.version}</TableCell>
                    <TableCell>
                      <span className="disp-cell">
                        {summary.label}
                        {summary.waiting && <Badge appearance="tint" color="severe">等待重评</Badge>}
                        {summary.conflicting && <Badge appearance="tint" color="danger">冲突待办</Badge>}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {selected && (
          <aside className="record-panel">
            <div className="record-title">
              <div>
                <span>{selected.id} · {selected.line}</span>
                <h2>{selected.product}</h2>
              </div>
              <Badge color={statusColor(selected.status)}>{selected.status}</Badge>
            </div>

            <dl>
              <div><dt>生产数量</dt><dd>{selected.quantity.toLocaleString()} 件</dd></div>
              <div><dt>隔离/影响范围</dt><dd>{selected.isolationScope}</dd></div>
              <div><dt>关联偏差处置版本</dt><dd>{selectBatchDispositionSummary(state, selected.id).label}</dd></div>
            </dl>

            <h3>监测点结果</h3>
            <div className="monitoring-list">
              {selected.monitoring.map((item) => (
                <div key={`${selected.id}-${item.stepId}`}>
                  <span>{state.processSteps.find((step) => step.id === item.stepId)?.controlPoint}</span>
                  <strong>{item.value} {item.unit}</strong>
                  <small>{item.operator} · {item.recordedAt.slice(11, 16)}</small>
                </div>
              ))}
            </div>

            {signed && (
              <div className="signature-block">
                <h3>放行签字（已冻结）</h3>
                <p><strong>{signature!.signer}</strong> · {signature!.signedAt.replace('T', ' ').slice(0, 16)}</p>
                <p>{signature!.note}</p>
                <small>
                  签字时控制矩阵 V{signature!.planVersion}；处置版本 {Object.entries(signature!.dispositionVersions).map(([dev, ver]) => `${dev}=V${ver}`).join('，') || '无'}。
                  此后关键限值/纠偏措施变化不改写本批次。
                </small>
              </div>
            )}

            {!signed && (
              <div>
                <div className="record-actions">
                  <Button appearance="secondary" disabled={openDeviations.length > 0} onClick={() => dispatch(updateBatchStatus({ id: selected.id, status: '可放行' }))}>提交放行复核</Button>
                  <Button appearance="primary" disabled={selected.status !== '可放行' || openDeviations.length > 0} onClick={() => dispatch(signBatchRelease({ id: selected.id, signer: '质量负责人 秦岚', note: signNote }))}>签字放行</Button>
                </div>
                {selected.status === '可放行' && openDeviations.length === 0 && (
                  <FieldLite label="放行签字意见">
                    <Textarea value={signNote} onChange={(_, data) => setSignNote(data.value)} />
                  </FieldLite>
                )}
                {openDeviations.length > 0 && (
                  <p className="validation-text">存在 {openDeviations.length} 项未关闭或等待重评的偏差，系统已阻止放行；两窗口同时签字时后到一方将进入冲突待办。</p>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}

function FieldLite({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field-lite">
      <label>{label}</label>
      {children}
    </div>
  )
}
