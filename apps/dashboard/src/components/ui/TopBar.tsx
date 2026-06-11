import { Bell, Moon, Sun } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '../../hooks/useTheme'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../lib/api'
import { getSession } from '../../lib/auth'

type Props = {
  title: string
  sub?: string
  onBell?: () => void
  bellDot?: boolean
  right?: React.ReactNode
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).map(p => p[0]).join('').toUpperCase().slice(0, 2) || 'M'
}

export function TopBar({ title, sub, onBell, bellDot, right }: Props) {
  const { isDark, toggle } = useTheme()
  const { toast } = useToast()

  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data } = useQuery<{ merchant: { name: string } }>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${merchantId}`)
      if (!res.ok) return { merchant: { name: '' } }
      return res.json()
    },
  })

  const av = initials(data?.merchant?.name ?? '')
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
      <div className="avatar">{av}</div>
    </div>
  )
}
