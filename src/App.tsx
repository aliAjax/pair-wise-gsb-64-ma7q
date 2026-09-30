import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Badge, Button } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'
import { dismissNotice, resetDemo, signBatchRelease, updateBatchStatus, updateProcessStep, saveInvestigation, reviewDeviation, reevaluateDeviation, createDeviation, type RetrySpec } from './store/haccpSlice'
import { Overview } from './views/Overview'
import { ProcessControl } from './views/ProcessControl'
import { DeviationWorkbench } from './views/DeviationWorkbench'
import { AuditTrail } from './views/AuditTrail'

const navigation = [
  ['/', '生产批次'],
  ['/process', 'HACCP控制矩阵'],
  ['/deviations', '偏差调查'],
  ['/audit', '追溯审计']
]

function NoticeBar() {
  const dispatch = useDispatch<AppDispatch>()
  const notices = useSelector((state: RootState) => state.haccp.notices)
  const storageMode = useSelector((state: RootState) => state.haccp.storageMode)
  const bootNotes = useSelector((state: RootState) => state.haccp.bootNotes)
  const planVersion = useSelector((state: RootState) => state.haccp.planVersion)

  const runRetry = (retry: RetrySpec) => {
    switch (retry.type) {
      case 'matrix':
        dispatch(updateProcessStep({ step: retry.step, operator: retry.operator }))
        break
      case 'investigation':
        dispatch(saveInvestigation({ id: retry.id, investigation: retry.investigation }))
        break
      case 'review':
        dispatch(reviewDeviation({ id: retry.id, approved: retry.approved, note: retry.note, reviewer: retry.reviewer }))
        break
      case 'reeval':
        dispatch(reevaluateDeviation({ id: retry.id, investigation: retry.investigation, note: retry.notice, reviewer: retry.reviewer }))
        break
      case 'sign':
        dispatch(signBatchRelease({ id: retry.id, signer: retry.signer, note: retry.note }))
        break
      case 'create':
        dispatch(createDeviation(retry))
        break
      case 'status':
        dispatch(updateBatchStatus({ id: retry.id, status: retry.status, operator: retry.operator }))
        break
    }
  }

  return (
    <div className="notice-stack">
      <div className="notice-banner info">
        <span>当前文档（控制矩阵+处置版本）V{planVersion} · {storageMode === 'memory' ? '内存模式（存储不可用）' : '本地持久化 · 两窗口实时同步'}</span>
      </div>
      {bootNotes.map((note, index) => <div key={`boot-${index}`} className="notice-banner info"><span>{note}</span></div>)}
      {notices.map((notice) => (
        <div key={notice.id} className={`notice-banner ${notice.level}`}>
          <div><strong>{notice.title}</strong><span>{notice.detail}</span></div>
          <footer>
            {notice.retry && <Button size="small" appearance="primary" onClick={() => runRetry(notice.retry!)}>重试并续接最新版本</Button>}
            <Button size="small" appearance="subtle" onClick={() => dispatch(dismissNotice(notice.id))}>知道了</Button>
          </footer>
        </div>
      ))}
    </div>
  )
}

function Shell() {
  const dispatch = useDispatch<AppDispatch>()
  const openDeviations = useSelector((state: RootState) => state.haccp.deviations.filter((item) => item.status !== '已关闭' || item.pendingReeval).length)
  const conflictCount = useSelector((state: RootState) => state.haccp.conflictInbox.filter((item) => item.status === '待处理').length
    + state.haccp.deviations.reduce((sum, dev) => sum + dev.dispositions.filter((item) => item.status === '冲突待办' && !item.conflictResolved).length, 0))
  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><b>H</b><div><strong>食品安全控制台</strong><small>HACCP批次与偏差追溯</small></div></div>
        <nav>
          {navigation.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <span>{label}</span>
              {label === '偏差调查' && openDeviations > 0 && <Badge appearance="filled" color="danger">{openDeviations}</Badge>}
              {label === '偏差调查' && conflictCount > 0 && <Badge appearance="filled" color="severe">冲突{conflictCount}</Badge>}
            </NavLink>
          ))}
        </nav>
        <div className="aside-note"><strong>生产日</strong><span>2026-09-30</span><small>版本化处置 · 可恢复审计</small></div>
      </aside>
      <main>
        <NoticeBar />
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/process" element={<ProcessControl />} />
          <Route path="/deviations" element={<DeviationWorkbench />} />
          <Route path="/audit" element={<AuditTrail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Button className="reset-button" appearance="subtle" onClick={() => dispatch(resetDemo())}>恢复演示数据</Button>
      </main>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}
