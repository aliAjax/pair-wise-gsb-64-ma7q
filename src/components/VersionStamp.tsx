export interface CommitNotice {
  tone: 'success' | 'warning' | 'danger'
  text: string
}

export function VersionStamp({ seq, label }: { seq: number; label?: string }) {
  return <span className="version-stamp" title={`处置版本 V${seq}${label ? ` · ${label}` : ''}`}>V{seq}</span>
}

export function NoticeBar({ notice, onDismiss }: { notice: CommitNotice | null; onDismiss?: () => void }) {
  if (!notice) return null
  return <div className={`notice-bar notice-${notice.tone}`} onClick={onDismiss} role="status">{notice.text}</div>
}
