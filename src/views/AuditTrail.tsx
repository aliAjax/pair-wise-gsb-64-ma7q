import { useState } from 'react'
import { Button, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'

export function AuditTrail() {
  const entries = useSelector((root: RootState) => root.haccp.audit)
  const [keyword, setKeyword] = useState('')
  const rows = entries.filter((item) => `${item.entity} ${item.action} ${item.operator} ${item.detail}`.includes(keyword))
  const exportAudit = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'HACCP追溯审计.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <section className="page"><header className="page-head"><div><p>批次 / 控制点 / 偏差 / 签字</p><h1>完整追溯审计</h1></div><Button appearance="primary" onClick={exportAudit}>导出追溯包</Button></header>
    <div className="toolbar"><Input value={keyword} onChange={(_, data) => setKeyword(data.value)} placeholder="搜索实体、动作、操作人" /><span>共{rows.length}条可追溯事件</span></div>
    <div className="table-panel"><Table size="small"><TableHeader><TableRow><TableHeaderCell>时间</TableHeaderCell><TableHeaderCell>实体</TableHeaderCell><TableHeaderCell>动作</TableHeaderCell><TableHeaderCell>操作人</TableHeaderCell><TableHeaderCell>说明</TableHeaderCell></TableRow></TableHeader><TableBody>{rows.map((item) => <TableRow key={item.id}><TableCell>{item.createdAt.replace('T', ' ').slice(0, 16)}</TableCell><TableCell>{item.entity}</TableCell><TableCell>{item.action}</TableCell><TableCell>{item.operator}</TableCell><TableCell>{item.detail}</TableCell></TableRow>)}</TableBody></Table></div>
  </section>
}
