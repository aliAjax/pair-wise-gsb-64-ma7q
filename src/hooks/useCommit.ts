import { useCallback, useState } from 'react'
import { useDispatch } from 'react-redux'
import { commitIntent, recoverPending, resolveConflictThunk, type CommitOutcome } from '../store/haccpSlice'
import type { AppDispatch } from '../store'
import type { Intent } from '../services/engine'
import type { CommitNotice } from '../components/VersionStamp'

/** 统一处置提交入口：成功、冲突待办、校验拦截、写入失败恢复均有明确反馈 */
export function useCommit() {
  const dispatch = useDispatch<AppDispatch>()
  const [notice, setNotice] = useState<CommitNotice | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async (intent: Intent, baseSeq?: number): Promise<CommitOutcome | null> => {
    setBusy(true)
    const action = await dispatch(commitIntent({ intent, baseSeq }))
    setBusy(false)
    const outcome = action.payload as CommitOutcome
    if (outcome.status === 'committed') {
      setNotice({ tone: 'success', text: `处置已作为完整版本 V${outcome.seq} 提交，审计与影响范围已同步。` })
    } else if (outcome.status === 'conflict') {
      setNotice({ tone: 'warning', text: `对方窗口已先行提交，本次提交进入冲突待办 ${outcome.conflictId}（未覆盖其证据/签字），请到“冲突待办”续提或放弃。` })
    } else if (outcome.status === 'persist-failed') {
      setNotice({ tone: 'danger', text: `${outcome.message} 可点击“故障恢复”接着最后完整版本继续。` })
    } else {
      setNotice({ tone: 'danger', text: `提交被拦截：${outcome.message}` })
    }
    return outcome
  }, [dispatch])

  const resolve = useCallback(async (conflictId: string, action: 'continue' | 'abandon') => {
    setBusy(true)
    const result = await dispatch(resolveConflictThunk({ conflictId, action }))
    setBusy(false)
    const outcome = result.payload as CommitOutcome
    if (outcome.status === 'committed') setNotice({ tone: 'success', text: `冲突待办已处理，完整版本 V${outcome.seq}。` })
    else if (outcome.status === 'persist-failed') setNotice({ tone: 'danger', text: `${outcome.message}` })
    else if (outcome.status === 'invalid') setNotice({ tone: 'danger', text: `处理失败：${outcome.message}` })
    return outcome
  }, [dispatch])

  const recover = useCallback(async () => {
    const result = await dispatch(recoverPending())
    const report = (result as { payload: { report: string } }).payload.report
    setNotice({ tone: report.includes('中止') || report.includes('不可写') ? 'danger' : 'success', text: report })
  }, [dispatch])

  return { submit, resolve, recover, notice, setNotice, busy }
}
