import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import type { HaccpState } from '../types'

/**
 * 快照查询仅保留加载态指示；真实数据走版本化状态（见 engine + haccpSlice）。
 */
export const haccpApi = createApi({
  reducerPath: 'haccpApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    loadBatchSnapshot: builder.query<{ loaded: boolean }, void>({
      queryFn: async () => ({ data: { loaded: true } })
    })
  })
})

export const { useLoadBatchSnapshotQuery } = haccpApi
export type SnapshotState = HaccpState
