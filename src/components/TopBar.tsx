import { useState } from 'react'
import { Badge, Button, Switch } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { currentWindowId } from '../store'
import { isWriteFault, setWriteFault } from '../services/storage'
import { recoverPending } from '../store/haccpSlice'
import { NoticeBar, type CommitNotice } from './VersionStamp'

export function TopBar() {
  const dispatch = useDispatch<AppDispatch>()
  const seq = useSelector((root: RootState) => root.haccp.dispositionSeq)
  const conflicts = useSelector((root: RootState) => root.haccp.conflicts.filter((item) => item.status === '待处理').length)
  const [fault, setFault] = useState(isWriteFault())
  const [notice, setNotice] = useState<CommitNotice | null>(null)

  const toggleFault = (on: boolean) => { setFault(on); setWriteFault(on) }
  const recover = async () => {
    const result = await dispatch(recoverPending())
    const report = (result as { payload: { report: string } }).payload.report
    setNotice({ tone: report.includes('中止') || report.includes('不可写') ? 'danger' : 'success', text: report })
  }

  return (
    <div className="topbar">
      <div className="topbar-group">
        <span className="topbar-label">当前处置版本</span>
        <strong className="topbar-seq">V{seq}</strong>
        <Badge appearance="outline" className="mono">{currentWindowId()}</Badge>
        {conflicts > 0 && <Badge appearance="filled" color="danger">{conflicts} 项冲突待办</Badge>}
      </div>
      <div className="topbar-group">
        <Switch label="模拟主快照写入失败" checked={fault} onChange={(_, data) => toggleFault(Boolean(data.checked))} />
        <Button size="small" appearance="subtle" onClick={recover}>故障恢复</Button>
      </div>
      {notice && <div className="topbar-notice"><NoticeBar notice={notice} onDismiss={() => setNotice(null)} /></div>}
    </div>
  )
}
