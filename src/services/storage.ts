import type { HaccpState, PendingCommit } from '../types'

const SNAPSHOT_KEY = 'gsb64:haccp-platform'
const WAL_KEY = 'gsb64:haccp-pending-v2'

/** 当前窗口标识，仅存于内存，不写入快照（避免覆盖其他窗口身份） */
export const windowId = `WIN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

/**
 * 快照写入故障开关：仅令主快照写入失败，前写日志仍可落盘，
 * 用于演示“写入失败 → WAL 恢复”，不留半套审计。
 */
let writeFault = false
export function setWriteFault(on: boolean) { writeFault = on }
export function isWriteFault() { return writeFault }

export function loadRawSnapshot(): unknown {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveSnapshot(state: HaccpState) {
  if (writeFault) throw new Error('主快照写入失败（存储故障模拟中）')
  // 版本、审计、业务数据在同一 JSON 中一次原子写入：要么整版可见，要么不可见
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(stripSessionFields(state)))
}

/** windowId 等会话字段不持久化 */
function stripSessionFields(state: HaccpState): HaccpState {
  const { windowId: _omit, ...persisted } = state
  return persisted as HaccpState
}

/** 前写日志：提交一整套处置之前先落盘，崩溃/写入失败后可原样重做。
 *  按窗口隔离，避免恢复时重放到其他窗口未完成的提交。 */
export function writePending(origin: string, pending: PendingCommit) {
  localStorage.setItem(`${WAL_KEY}:${origin}`, JSON.stringify(pending))
}

export function readPending(origin: string): PendingCommit | null {
  try {
    const raw = localStorage.getItem(`${WAL_KEY}:${origin}`)
    return raw ? JSON.parse(raw) as PendingCommit : null
  } catch {
    return null
  }
}

export function clearPending(origin: string) {
  localStorage.removeItem(`${WAL_KEY}:${origin}`)
}
