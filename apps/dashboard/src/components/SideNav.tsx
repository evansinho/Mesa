import { useNavigate, useRouterState } from '@tanstack/react-router'
import { House, ReceiptText, Users, Wallet, ChartNoAxesColumn, Package, CreditCard, Settings, LogOut } from 'lucide-react'
import { Lockup } from './ui/Lockup'
import { getSession, clearSession } from '../lib/auth'

const PRIMARY_TABS = [
  { id: '/',          label: 'Home',      Icon: House },
  { id: '/orders',    label: 'Orders',    Icon: ReceiptText },
  { id: '/customers', label: 'Customers', Icon: Users },
  { id: '/money',     label: 'Money',     Icon: Wallet },
  { id: '/insights',  label: 'Insights',  Icon: ChartNoAxesColumn },
]

const SECONDARY_TABS = [
  { id: '/inventory', label: 'Inventory', Icon: Package },
]

const TERTIARY_TABS = [
  { id: '/billing',  label: 'Billing',  Icon: CreditCard },
  { id: '/settings', label: 'Settings', Icon: Settings },
]

const ALL_TABS = [...PRIMARY_TABS, ...SECONDARY_TABS, ...TERTIARY_TABS]

function initials(name: string) {
  return name.split(' ').filter(Boolean).map(p => p[0]).join('').toUpperCase().slice(0, 2) || 'M'
}

export function SideNav() {
  const navigate = useNavigate()
  const state = useRouterState()
  const pathname = state.location.pathname
  const active = ALL_TABS.find(t => t.id === '/' ? pathname === '/' : pathname.startsWith(t.id))?.id ?? '/'

  const session = getSession()
  const merchantName = (session as { merchantName?: string } | null)?.merchantName ?? 'My Store'

  function handleSignOut() {
    clearSession()
    navigate({ to: '/login' })
  }

  const renderTab = ({ id, label, Icon }: (typeof ALL_TABS)[number]) => (
    <button
      key={id}
      className={`sn-item${active === id ? ' on' : ''}`}
      onClick={() => navigate({ to: id })}
    >
      <Icon size={19} strokeWidth={2} />
      {label}
    </button>
  )

  return (
    <nav className="sidenav">
      <div className="sn-brand">
        <Lockup markSize={32} wordSize={24} />
      </div>
      <div className="sn-nav">
        {PRIMARY_TABS.map(renderTab)}
        <div className="sn-div" />
        {SECONDARY_TABS.map(renderTab)}
        <div className="sn-div" />
        {TERTIARY_TABS.map(renderTab)}
      </div>
      <div className="sn-foot">
        <div className="sn-biz">
          <div className="avatar" style={{ width: 36, height: 36, fontSize: 15, borderRadius: 10 }}>
            {initials(merchantName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="sn-bn">{merchantName}</div>
            <div className="sn-bs"><span className="bd" />Connected</div>
          </div>
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            title="Sign out"
            style={{ padding: 6, borderRadius: 8, color: 'var(--subtle)', background: 'none', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0, transition: 'color .12s' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--danger)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--subtle)')}
          >
            <LogOut size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </nav>
  )
}
