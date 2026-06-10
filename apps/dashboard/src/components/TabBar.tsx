import { useNavigate, useRouterState } from '@tanstack/react-router'
import { House, ReceiptText, Wallet, ChartNoAxesColumn, Menu } from 'lucide-react'

const TABS = [
  { id: '/',         label: 'Home',     Icon: House },
  { id: '/orders',   label: 'Orders',   Icon: ReceiptText },
  { id: '/money',    label: 'Money',    Icon: Wallet },
  { id: '/insights', label: 'Insights', Icon: ChartNoAxesColumn },
  { id: '/more',     label: 'More',     Icon: Menu },
]

export function TabBar() {
  const navigate = useNavigate()
  const state = useRouterState()
  const pathname = state.location.pathname
  const active = TABS.find(t => t.id === '/' ? pathname === '/' : pathname.startsWith(t.id))?.id ?? '/'

  return (
    <nav className="tabbar">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`tab${active === id ? ' active' : ''}`}
          onClick={() => navigate({ to: id })}
        >
          <div className="ti">
            <div className="tbubble" />
            <Icon size={22} strokeWidth={active === id ? 2.2 : 1.8} />
          </div>
          <span className="tlab">{label}</span>
        </button>
      ))}
    </nav>
  )
}
