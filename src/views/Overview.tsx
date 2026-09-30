import { useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Dropdown, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import type { AppDispatch, RootState } from '../store'
import { setBatchFilter, setBatchStatus, setSelectedBatch } from '../store/haccpSlice'
import type { BatchStatus } from '../types'
import { useLoadBatchSnapshotQuery } from '../services/api'
import { useCommit } from '../hooks/useCommit'
import { NoticeBar, VersionStamp } from '../components/VersionStamp'

const statuses: Array<BatchStatus | '全部'> = ['全部', '生产中', '待复核', '可放行', '隔离中', '已放行', '已报废']
const statusColor = (status: BatchStatus) => status === '隔离中' || status === '已报废' ? 'danger' : status === '已放行' ? 'success' : status === '可放行' ? 'important' : 'warning'

export function Overview() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const { isFetching } = useLoadBatchSnapshotQuery()
  const { submit, notice, busy } = useCommit()
  const rows = useMemo(() => state.batches.filter((batch) => {
    const text = `${batch.id} ${batch.product} ${batch.line}`.toLowerCase()
    return (!state.batchFilter || text.includes(state.batchFilter.toLowerCase())) && (state.batchStatus === '全部' || batch.status === state.batchStatus)
  }), [state.batches, state.batchFilter, state.batchStatus])
  const selected = state.batches.find((item) => item.id === state.selectedBatchId) ?? rows[0]
  const selectedDeviations = state.deviations.filter((item) => item.batchId === selected?.id)
  const openCount = selectedDeviations.filter((item) => item.status !== '已关闭').length
  const reassessCount = selectedDeviations.filter((item) => item.status === '待重评').length

  return (
    <section className="page">
      <header className="page-head"><div><p>质量运营中心 / 批次控制 · 处置版本 V{state.dispositionSeq}</p><h1>生产批次与放行</h1></div><span className="sync-state">{isFetching ? '正在加载' : '版本快照已加载'}</span></header>
      <NoticeBar notice={notice} />
      <div className="metrics">
        <article><span>今日批次</span><strong>{state.batches.length}</strong><small>覆盖2条生产线</small></article>
        <article><span>隔离批次</span><strong>{state.batches.filter((item) => item.status === '隔离中').length}</strong><small>禁止放行</small></article>
        <article><span>未关闭偏差</span><strong>{state.deviations.filter((item) => item.status !== '已关闭').length}</strong><small>含待重评，需重新评估</small></article>
        <article><span>已放行（签字冻结）</span><strong>{state.batches.filter((item) => item.status === '已放行').length}</strong><small>矩阵变更不改写</small></article>
      </div>
      <div className="toolbar">
        <Input value={state.batchFilter} onChange={(_, data) => dispatch(setBatchFilter(data.value))} placeholder="搜索批次、产品、产线" />
        <Dropdown value={state.batchStatus} selectedOptions={[state.batchStatus]} onOptionSelect={(_, data) => dispatch(setBatchStatus(data.optionValue as BatchStatus | '全部'))}>
          {statuses.map((status) => <Option key={status} value={status}>{status}</Option>)}
        </Dropdown>
        <span>列表、偏差工作台与追溯审计显示同一处置版本</span>
      </div>
      <div className="split-layout">
        <div className="table-panel">
          <Table size="small" aria-label="生产批次">
            <TableHeader><TableRow><TableHeaderCell>批次</TableHeaderCell><TableHeaderCell>产品</TableHeaderCell><TableHeaderCell>产线</TableHeaderCell><TableHeaderCell>状态</TableHeaderCell><TableHeaderCell>处置版本</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {rows.map((batch) => <TableRow key={batch.id} onClick={() => dispatch(setSelectedBatch(batch.id))} className={batch.id === selected?.id ? 'selected-row' : ''}>
                <TableCell>{batch.id}</TableCell><TableCell>{batch.product}</TableCell><TableCell>{batch.line}</TableCell>
                <TableCell><Badge appearance="tint" color={statusColor(batch.status) as 'danger'}>{batch.status}</Badge></TableCell>
                <TableCell><VersionStamp seq={batch.dispositionSeq} /></TableCell>
              </TableRow>)}
            </TableBody>
          </Table>
        </div>
        {selected && <aside className="record-panel">
          <div className="record-title"><div><span>{selected.id} · 处置版本 <VersionStamp seq={selected.dispositionSeq} /></span><h2>{selected.product}</h2></div><Badge color={statusColor(selected.status) as 'danger'}>{selected.status}</Badge></div>
          <dl><div><dt>生产数量</dt><dd>{selected.quantity.toLocaleString()} 件</dd></div><div><dt>隔离范围</dt><dd>{selected.isolationScope}</dd></div><div><dt>关联偏差</dt><dd>{selectedDeviations.length} 项{reassessCount > 0 ? `（${reassessCount} 待重评）` : ''}</dd></div></dl>
          {selected.release && <div className="frozen-band">
            <strong>放行签字已冻结</strong>
            <span>{selected.release.operator} · {selected.release.signedAt.replace('T', ' ').slice(0, 16)} · 依据 V{selected.release.basisSeq}</span>
            <small>后续关键限值/纠偏措施版本不再改写本批次状态与签字。</small>
          </div>}
          <h3>监测点结果</h3>
          <div className="monitoring-list">{selected.monitoring.map((item) => {
            const step = state.processSteps.find((s) => s.id === item.stepId)
            return <div key={`${selected.id}-${item.stepId}`}><span>{step?.controlPoint} <em className="mono">V{step?.dispositionSeq ?? selected.dispositionSeq}</em></span><strong>{item.value} {item.unit}</strong><small>{item.operator} · {item.recordedAt.slice(11, 16)}</small></div>
          })}</div>
          {!selected.release && <div className="record-actions">
            <Button appearance="secondary" disabled={busy || openCount > 0} onClick={() => void submit({ type: 'batchTransition', batchId: selected.id, status: '可放行' })}>提交放行复核</Button>
            <Button appearance="primary" disabled={busy || selected.status !== '可放行'} onClick={() => void submit({ type: 'releaseSign', batchId: selected.id })}>签字放行</Button>
          </div>}
          {!selected.release && openCount > 0 && <p className="validation-text">存在{reassessCount > 0 ? ` ${reassessCount} 项“待重评”和` : ''}未关闭偏差（证据已保留），须完成重评复核后才能放行。</p>}
        </aside>}
      </div>
    </section>
  )
}
