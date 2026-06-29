import { Bell, Moon, Sun } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import { useToast } from '../../context/ToastContext'

type Props = {
  title: string
  sub?: string
  onBell?: () => void
  bellDot?: boolean
  right?: React.ReactNode
}

export function TopBar({ title, sub, onBell, bellDot, right }: Props) {
  const { isDark, toggle } = useTheme()
  const { toast } = useToast()

  const handleBell = onBell ?? (() => toast('Notifications coming soon'))

  return (
    <div className="topbar">
      <div className="tb-main">
        <div className="tb-title">{title}</div>
        {sub && <div className="tb-sub">{sub}</div>}
      </div>
      {right}
      <button className="iconbtn" onClick={toggle} aria-label="Toggle theme">
        {isDark ? <Sun size={19} strokeWidth={2} /> : <Moon size={19} strokeWidth={2} />}
      </button>
      <button className="iconbtn" onClick={handleBell} aria-label="Notifications">
        <Bell size={20} strokeWidth={2} />
        {bellDot && <span className="dot" />}
      </button>
    </div>
  )
}
