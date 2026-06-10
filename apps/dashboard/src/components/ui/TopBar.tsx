import { Bell } from 'lucide-react'

type Props = {
  title: string
  sub?: string
  avatar?: string
  onBell?: () => void
  bellDot?: boolean
  right?: React.ReactNode
}

export function TopBar({ title, sub, avatar, onBell, bellDot, right }: Props) {
  return (
    <div className="topbar">
      <div className="tb-main">
        <div className="tb-title">{title}</div>
        {sub && <div className="tb-sub">{sub}</div>}
      </div>
      {right}
      {onBell && (
        <button className="iconbtn" onClick={onBell} aria-label="Notifications">
          <Bell size={20} strokeWidth={2} />
          {bellDot && <span className="dot" />}
        </button>
      )}
      {avatar && (
        <div className="avatar">{avatar}</div>
      )}
    </div>
  )
}
