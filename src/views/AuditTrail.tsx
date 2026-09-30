import { useMemo, useState } from 'react'
import { Badge, Button, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'
import type { DispositionKind } from '../types'
import { VersionStamp } from '../components/VersionStamp'

const kindColor: Record<DispositionKind, string> = {
  基线: 'informative', 迁移: 'informative', 矩阵变更: 'important', 偏差登记: 'warning',
  调查提交: 'warning', 复核结论: 'brand', 批次流转: 'informative', 放行签字: 'success',
  冲突登记: 'danger', 冲突续提: 'severe', 放弃冲突: 'danger', 演示重置: 'informative'
}

export function AuditTrail() {
  const state = useSelector((root: RootState) => root.haccp)
  const [keyword, setKeyword] = useState('')
  const [seqFilter, setSeqFilter] = useState<number | null>(null)

  const entries = useMemo(() => state.audit.filter((item) => {
    const text = `${item.entity} ${item.action} ${item.operator} ${item.detail}`
    return text.includes(keyword) && (seqFilter === null || item.dispositionSeq === seqFilter)
  }), [state.audit, keyword, seqFilter])

  const exportAudit = () => {
    const pack = {
      exportedAt: new Date().toISOString(),
      currentDispositionSeq: state.dispositionSeq,
      versions: state.versions,
      conflicts: state.conflicts,
      audit: state.audit,
      batches: state.batches,
      deviations: state.deviations,
      processSteps: state.processSteps
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'HACCP追溯审计包.json'; anchor.click(); URL.revokeObjectURL(url)
  }

  return <section className="page">
    <header className="page-head"><div><p>批次 / 控制点 / 偏差 / 签字 · 最新完整版本 <VersionStamp seq={state.dispositionSeq} /></p><h1>完整追溯审计</h1></div><Button appearance="primary" onClick={exportAudit}>导出追溯包（含版本链）</Button></header>

    <div className="audit-layout">
      <div className="version-timeline">
        <h3>处置版本链</h3>
        {state.versions.map((version) => (
          <button key={version.seq} className={`version-node ${seqFilter === version.seq ? 'active' : ''}`} onClick={() => setSeqFilter(seqFilter === version.seq ? null : version.seq)}>
            <div className="version-node-head"><VersionStamp seq={version.seq} /><Badge appearance="tint" color={kindColor[version.kind] as 'brand'}>{version.kind}</Badge></div>
            <span>{version.summary}</span>
            <footer>
              <small className="mono">{version.origin} · {version.operator}</small>
              <small>{version.createdAt.replace('T', ' ').slice(5, 16)}</small>
            </footer>
            <div className="impact-chips">
              {version.impact.batches.map((id) => <Badge key={`b-${id}`} size="small" appearance="outline">批 {id}</Badge>)}
              {version.impact.deviations.map((id) => <Badge key={`d-${id}`} size="small" appearance="outline" color="warning">偏 {id}</Badge>)}
              {version.impact.steps.map((id) => <Badge key={`s-${id}`} size="small" appearance="outline" color="important">点 {id}</Badge>)}
              {version.impact.frozenReleased.map((id) => <Badge key={`f-${id}`} size="small" color="success">冻结 {id}</Badge>)}
            </div>
          </button>
        ))}
      </div>

      <div className="audit-main">
        <div className="toolbar">
          <Input value={keyword} onChange={(_, data) => setKeyword(data.value)} placeholder="搜索实体、动作、操作人" />
          {seqFilter !== null && <Button size="small" appearance="subtle" onClick={() => setSeqFilter(null)}>清除版本筛选 V{seqFilter}</Button>}
          <span>共{entries.length}条事件；每条均归属一个完整处置版本，无半套审计</span>
        </div>
        <div className="table-panel"><Table size="small">
          <TableHeader><TableRow><TableHeaderCell>时间</TableHeaderCell><TableHeaderCell>版本</TableHeaderCell><TableHeaderCell>实体</TableHeaderCell><TableHeaderCell>动作</TableHeaderCell><TableHeaderCell>操作人</TableHeaderCell><TableHeaderCell>说明</TableHeaderCell></TableRow></TableHeader>
          <TableBody>{entries.map((item) => <TableRow key={item.id} onClick={() => setSeqFilter(item.dispositionSeq)} className="audit-row">
            <TableCell>{item.createdAt.replace('T', ' ').slice(0, 16)}</TableCell>
            <TableCell><VersionStamp seq={item.dispositionSeq} /></TableCell>
            <TableCell>{item.entity}</TableCell>
            <TableCell>{item.action}</TableCell>
            <TableCell>{item.operator}</TableCell>
            <TableCell>{item.detail}</TableCell>
          </TableRow>)}</TableBody>
        </Table></div>
      </div>
    </div>
  </section>
}
