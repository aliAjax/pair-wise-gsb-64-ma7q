import { useState } from 'react'
import { Badge, Button, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'
import { getWindowId } from '../services/planSync'

export function AuditTrail() {
  const doc = useSelector((root: RootState) => root.haccp)
  const [keyword, setKeyword] = useState('')
  const rows = doc.audit.filter((item) => `${item.entity} ${item.action} ${item.operator} ${item.detail} V${item.planVersion}`.includes(keyword))

  const exportAudit = () => {
    // 导出整个计划文档：处置版本链、签字、冲突处理与审计始终处于同一文档版本。
    const pack = {
      exportedAt: new Date().toISOString(),
      currentPlanVersion: doc.planVersion,
      windowId: getWindowId(),
      processSteps: doc.processSteps,
      batches: doc.batches,
      deviations: doc.deviations,
      releaseSignatures: doc.signatures,
      conflictInbox: doc.conflictInbox,
      audit: doc.audit
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `HACCP追溯包-V${doc.planVersion}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <section className="page">
    <header className="page-head">
      <div><p>批次 / 控制点 / 偏差 / 签字 / 冲突</p><h1>完整追溯审计</h1></div>
      <Button appearance="primary" onClick={exportAudit}>导出追溯包（含处置版本链）</Button>
    </header>
    <div className="toolbar">
      <Input value={keyword} onChange={(_, data) => setKeyword(data.value)} placeholder="搜索实体、动作、操作人" />
      <span>当前文档V{doc.planVersion}，共{rows.length}条事件；每条记录标注产生时的控制矩阵版本与处置版本。</span>
    </div>
    <div className="table-panel">
      <Table size="small">
        <TableHeader><TableRow>
          <TableHeaderCell>时间</TableHeaderCell><TableHeaderCell>实体</TableHeaderCell><TableHeaderCell>动作</TableHeaderCell>
          <TableHeaderCell>操作人/窗口</TableHeaderCell><TableHeaderCell>矩阵版本</TableHeaderCell><TableHeaderCell>处置版本</TableHeaderCell>
          <TableHeaderCell>说明</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>{rows.map((item) => <TableRow key={item.id} className={item.conflict ? 'conflict-row' : ''}>
          <TableCell>{item.createdAt.replace('T', ' ').slice(0, 16)}</TableCell>
          <TableCell>{item.entity}</TableCell>
          <TableCell>{item.conflict ? <Badge appearance="tint" color="danger">{item.action}</Badge> : item.action}</TableCell>
          <TableCell>{item.operator}{item.windowId ? <small className="window-tag">{item.windowId}</small> : null}</TableCell>
          <TableCell><strong>V{item.planVersion}</strong></TableCell>
          <TableCell>{item.dispositionVersion ? `V${item.dispositionVersion}` : '—'}</TableCell>
          <TableCell>{item.detail}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>

    <h3 className="timeline-title">批次放行签字索引（签字即冻结，矩阵改版不改写）</h3>
    <div className="table-panel">
      <Table size="small">
        <TableHeader><TableRow><TableHeaderCell>批次</TableHeaderCell><TableHeaderCell>签字人</TableHeaderCell><TableHeaderCell>签字时间</TableHeaderCell><TableHeaderCell>锁定矩阵版本</TableHeaderCell><TableHeaderCell>锁定处置版本</TableHeaderCell><TableHeaderCell>意见</TableHeaderCell></TableRow></TableHeader>
        <TableBody>{doc.signatures.map((sig) => <TableRow key={`${sig.batchId}-${sig.signedAt}`}>
          <TableCell>{sig.batchId}</TableCell><TableCell>{sig.signer}</TableCell><TableCell>{sig.signedAt.replace('T', ' ').slice(0, 16)}</TableCell>
          <TableCell>V{sig.planVersion}</TableCell>
          <TableCell>{Object.entries(sig.dispositionVersions).map(([dev, ver]) => `${dev}=V${ver}`).join('，') || '无关联偏差'}</TableCell>
          <TableCell>{sig.note}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>
  </section>
}
