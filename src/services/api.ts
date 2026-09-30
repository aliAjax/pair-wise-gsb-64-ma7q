import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { seedBatches } from '../data/seed'
import type { Batch } from '../types'

export const haccpApi = createApi({
  reducerPath: 'haccpApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    loadBatchSnapshot: builder.query<Batch[], void>({
      queryFn: async () => ({ data: structuredClone(seedBatches) })
    }),
    checkReleaseReadiness: builder.query<{ ready: boolean; reasons: string[] }, { batchId: string; openDeviations: number }>({
      queryFn: async ({ batchId, openDeviations }) => ({
        data: {
          ready: openDeviations === 0,
          reasons: openDeviations === 0 ? [] : [`${batchId}仍有${openDeviations}项未关闭偏差`]
        }
      })
    })
  })
})

export const { useLoadBatchSnapshotQuery, useCheckReleaseReadinessQuery } = haccpApi
