import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { House, ReceiptText, Users, Wallet, ChartNoAxesColumn, Package, CreditCard, Settings, LogOut } from 'lucide-react'
import { Lockup } from './ui/Lockup'
import { getSession, clearSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type Product = { stockQuantity: number; lowStockThreshold: number }

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

function getBotStatus(config?: Record<string, unknown>): 'on' | 'paused' | 'assist' {
  if (config?.paused === true) return 'paused'
  const bot = config?.bot as { enabled?: boolean } | undefined
  return bot?.enabled === false ? 'assist' : 'on'
}

const BOT_LABELS = { on: 'Bot on', paused: 'Paused', assist: 'Assist' }

export function SideNav() {
  const navigate = useNavigate()
  const state = useRouterState()
  const pathname = state.location.pathname
  const active = ALL_TABS.find(t => t.id === '/' ? pathname === '/' : pathname.startsWith(t.id))?.id ?? '/'

  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data: merchantData } = useQuery<{ merchant: { name: string; config?: Record<string, unknown> } }>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${merchantId}`)
      if (!res.ok) return { merchant: { name: '' } }
      return res.json()
    },
  })

  const { data: ordersData } = useQuery<{ orders: { status: string }[] }>({
    queryKey: ['orders-all', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/orders?merchantId=${encodeURIComponent(merchantId)}&limit=100`)
      if (!res.ok) return { orders: [] }
      return res.json()
    },
  })

  const { data: productsData } = useQuery<Product[]>({
    queryKey: ['products', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}/products`)
      if (!res.ok) return []
      const json = await res.json() as { products?: Product[] }
      return json.products ?? []
    },
  })

  const merchantName = merchantData?.merchant?.name ?? 'My Store'
  const config = merchantData?.merchant?.config
  const botStatus = getBotStatus(config)
  const pendingCount = (ordersData?.orders ?? []).filter(o => o.status === 'PENDING').length
  const lowStockCount = (productsData ?? []).filter(p => p.stockQuantity <= p.lowStockThreshold).length

  function handleSignOut() {
    clearSession()
    navigate({ to: '/login' })
  }

  const renderTab = ({ id, label, Icon }: (typeof ALL_TABS)[number]) => {
    const badge = id === '/orders' && pendingCount > 0
      ? <span className="sn-badge sn-badge-danger">{pendingCount}</span>
      : id === '/inventory' && lowStockCount > 0
        ? <span className="sn-badge sn-badge-amber">{lowStockCount} low</span>
        : null

    return (
      <button
        key={id}
        className={`sn-item${active === id ? ' on' : ''}`}
        onClick={() => navigate({ to: id })}
      >
        <Icon size={19} strokeWidth={2} />
        {label}
        {badge}
      </button>
    )
  }

  return (
    <nav className="sidenav">
      <div className="sn-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Lockup markSize={32} wordSize={24} />
          <button
            className={`bot-chip ${botStatus}`}
            onClick={() => navigate({ to: '/settings' })}
            title="Bot settings"
          >
            <span className="bc-dot" />
            {BOT_LABELS[botStatus]}
          </button>
        </div>
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
            <div className="sn-bs"><span className="bd" />WhatsApp live</div>
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
