import { configureStore } from '@reduxjs/toolkit'
import haccpReducer from './haccpSlice'
import { haccpApi } from '../services/api'

export const store = configureStore({
  reducer: {
    haccp: haccpReducer,
    [haccpApi.reducerPath]: haccpApi.reducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(haccpApi.middleware)
})

store.subscribe(() => {
  try {
    localStorage.setItem('gsb64:haccp-platform', JSON.stringify(store.getState().haccp))
  } catch {
    // The app remains usable when browser storage is unavailable.
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
