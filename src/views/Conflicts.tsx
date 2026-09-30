import { Badge, Button } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'
import { useCommit } from '../hooks/useCommit'
import { NoticeBar } from '../components/VersionStamp'

const badge = (status: string) => status === '待处理' ? 'danger' : status === '已续提' ? 'success' : 'warning'

export function Conflicts() {
  const conflicts = useSelector((root: RootState) => root.haccp.conflicts)
  const currentSeq = useSelector((root: RootState) => root.haccp.dispositionSeq)
  const { resolve, recover, notice, busy } = useCommit()

  return (
    <section className="page">
      <header className="page-head">
        <div><p>并发控制 / 两窗口同版本提交</p><h1>冲突待办</h1></div>
        <Button appearance="subtle" onClick={recover}>故障恢复（重做前写日志）</Button>
      </header>
      <NoticeBar notice={notice} />
      <div className="rule-band">
        <span>后到一方的处置在此排队：可<strong>续提</strong>（变基到当前最新完整版本 V{currentSeq} 重做，保留对方证据与签字）或<strong>放弃</strong>。任何一方都不能覆盖对方已提交的证据或签字。</span>
      </div>
      <div className="conflict-list">
        {conflicts.length === 0 && <div className="empty-state">暂无冲突待办。两个窗口基于同一版本同时提交时，后到一方会自动进入这里。</div>}
        {conflicts.map((item) => (
          <article key={item.id} className="conflict-card">
            <header>
              <div><Badge color={badge(item.status) as 'danger'}>{item.status}</Badge><strong>{item.summary}</strong></div>
              <span className="mono">{item.id}</span>
            </header>
            <dl>
              <div><dt>类型</dt><dd>{item.kind}</dd></div>
              <div><dt>发起窗口</dt><dd className="mono">{item.origin}</dd></div>
              <div><dt>操作人</dt><dd>{item.operator}</dd></div>
              <div><dt>提交基准</dt><dd>V{item.baseSeq}</dd></div>
              <div><dt>对方先提交</dt><dd>V{item.winnerSeq}</dd></div>
              <div><dt>到达时间</dt><dd>{item.createdAt.replace('T', ' ').slice(0, 19)}</dd></div>
              {item.resolvedSeq !== undefined && <div><dt>处理版本</dt><dd>V{item.resolvedSeq}</dd></div>}
            </dl>
            {item.status === '待处理' && (
              <div className="record-actions">
                <Button disabled={busy} onClick={() => resolve(item.id, 'abandon')}>放弃（以对方版本为准）</Button>
                <Button appearance="primary" disabled={busy} onClick={() => resolve(item.id, 'continue')}>续提到 V{currentSeq} 重做</Button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
