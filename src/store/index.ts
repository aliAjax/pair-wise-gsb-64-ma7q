import { configureStore } from '@reduxjs/toolkit'
import haccpReducer, { hydrateDoc } from './haccpSlice'
import { haccpApi } from '../services/api'
import { readDoc, STORAGE_KEY } from '../services/planSync'

export const store = configureStore({
  reducer: {
    haccp: haccpReducer,
    [haccpApi.reducerPath]: haccpApi.reducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(haccpApi.middleware)
})

/**
 * 两个浏览器窗口协同：任一方完成完整版本提交后，主 key 整体切换；
 * 其它窗口通过 storage 事件收到最后一个完整版本并同步处置版本/审计，
 * 未提交的本地表单不动，提交时再走 CAS（过期则重放或进入冲突待办）。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    const doc = readDoc()
    if (doc && doc.planVersion > store.getState().haccp.planVersion) {
      store.dispatch(hydrateDoc(doc))
    }
  })
}

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
