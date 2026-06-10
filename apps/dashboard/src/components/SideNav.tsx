import { useNavigate, useRouterState } from '@tanstack/react-router'
import { House, ReceiptText, Wallet, ChartNoAxesColumn, Menu } from 'lucide-react'
import { Lockup } from './ui/Lockup'
import { getSession } from '../lib/auth'

const TABS = [
  { id: '/',         label: 'Home',     Icon: House },
  { id: '/orders',   label: 'Orders',   Icon: ReceiptText },
  { id: '/money',    label: 'Money',    Icon: Wallet },
  { id: '/insights', label: 'Insights', Icon: ChartNoAxesColumn },
  { id: '/more',     label: 'More',     Icon: Menu },
]

function initials(name: string) {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)
}

export function SideNav() {
  const navigate = useNavigate()
  const state = useRouterState()
  const pathname = state.location.pathname
  const active = TABS.find(t => t.id === '/' ? pathname === '/' : pathname.startsWith(t.id))?.id ?? '/'

  const session = getSession()
  const merchantName = (session as { merchantName?: string } | null)?.merchantName ?? 'My Store'

  return (
    <nav className="sidenav">
      <div className="sn-brand">
        <Lockup markSize={32} wordSize={24} />
      </div>
      <div className="sn-nav">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`sn-item${active === id ? ' on' : ''}`}
            onClick={() => navigate({ to: id })}
          >
            <Icon size={19} strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>
      <div className="sn-div" />
      <div className="sn-foot">
        <div className="sn-biz">
          <div className="avatar" style={{ width: 36, height: 36, fontSize: 15, borderRadius: 10 }}>
            {initials(merchantName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sn-bn">{merchantName}</div>
            <div className="sn-bs"><span className="bd" />Connected</div>
          </div>
        </div>
      </div>
    </nav>
  )
}
