import { NavLink, Navigate, Route, Routes, BrowserRouter } from 'react-router-dom'
import { Badge, Button } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'
import { resetDemo } from './store/haccpSlice'
import { Overview } from './views/Overview'
import { ProcessControl } from './views/ProcessControl'
import { DeviationWorkbench } from './views/DeviationWorkbench'
import { AuditTrail } from './views/AuditTrail'
import { Conflicts } from './views/Conflicts'
import { TopBar } from './components/TopBar'

const navigation = [
  ['/', '生产批次'],
  ['/process', 'HACCP控制矩阵'],
  ['/deviations', '偏差工作台'],
  ['/conflicts', '冲突待办'],
  ['/audit', '追溯审计']
]

function Shell() {
  const dispatch = useDispatch<AppDispatch>()
  const openDeviations = useSelector((state: RootState) => state.haccp.deviations.filter((item) => item.status !== '已关闭').length)
  const openConflicts = useSelector((state: RootState) => state.haccp.conflicts.filter((item) => item.status === '待处理').length)
  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><b>H</b><div><strong>食品安全控制台</strong><small>HACCP版本化偏差处置</small></div></div>
        <nav>
          {navigation.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <span>{label}</span>
              {label === '偏差工作台' && openDeviations > 0 && <Badge appearance="filled" color="danger">{openDeviations}</Badge>}
              {label === '冲突待办' && openConflicts > 0 && <Badge appearance="filled" color="warning">{openConflicts}</Badge>}
            </NavLink>
          ))}
        </nav>
        <div className="aside-note"><strong>生产日</strong><span>2026-09-30</span><small>版本链 · WAL 恢复 · 本地持久化</small></div>
      </aside>
      <main>
        <TopBar />
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/process" element={<ProcessControl />} />
          <Route path="/deviations" element={<DeviationWorkbench />} />
          <Route path="/conflicts" element={<Conflicts />} />
          <Route path="/audit" element={<AuditTrail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Button className="reset-button" appearance="subtle" onClick={() => void dispatch(resetDemo())}>恢复演示数据</Button>
      </main>
    </div>
  )
}

export function App() {
  return <BrowserRouter><Shell /></BrowserRouter>
}
