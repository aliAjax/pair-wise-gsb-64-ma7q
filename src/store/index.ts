import { configureStore } from '@reduxjs/toolkit'
import haccpReducer, { bootstrap } from './haccpSlice'
import { haccpApi } from '../services/api'
import { migrate } from '../services/engine'
import { loadRawSnapshot, windowId } from '../services/storage'
import type { HaccpState } from '../types'

export const store = configureStore({
  reducer: {
    haccp: haccpReducer,
    [haccpApi.reducerPath]: haccpApi.reducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(haccpApi.middleware)
})

// 启动：旧数据迁移 + 本窗口前写日志恢复
void store.dispatch(bootstrap())

// 跨窗口（两个浏览器窗口同时操作）：对方提交完整版本后本窗口跟随，
// 不覆盖本窗口正在编辑的过滤条件。
window.addEventListener('storage', (event) => {
  if (event.key !== 'gsb64:haccp-platform' || !event.newValue) return
  try {
    const incoming = migrate(JSON.parse(event.newValue))
    const current = store.getState().haccp as HaccpState
    // seq 不同即跟随对方的完整快照（绝不接受回退覆盖）；本窗口若有未持久化提交，
    // 其前写日志仍在，下次提交/恢复时会因基准不符进入冲突待办，不会覆盖对方。
    if (incoming.dispositionSeq !== current.dispositionSeq && incoming.dispositionSeq >= current.dispositionSeq) {
      store.dispatch({ type: 'haccp/hydrate', payload: incoming })
    }
  } catch {
    // 对端写入不可解析时忽略，等待下一条完整快照
  }
})

export function currentWindowId() { return windowId }

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
