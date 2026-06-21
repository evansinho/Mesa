import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { House, ReceiptText, Wallet, TrendingUp, MoreHorizontal } from 'lucide-react'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

const TABS = [
  { id: '/',          label: 'Home',     Icon: House },
  { id: '/orders',    label: 'Orders',   Icon: ReceiptText },
  { id: '/money',     label: 'Money',    Icon: Wallet },
  { id: '/insights',  label: 'Insights', Icon: TrendingUp },
  { id: '/more',      label: 'More',     Icon: MoreHorizontal },
]

export function TabBar() {
  const navigate = useNavigate()
  const state = useRouterState()
  const pathname = state.location.pathname
  const active = TABS.find(t => t.id === '/' ? pathname === '/' : pathname.startsWith(t.id))?.id ?? '/'

  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data } = useQuery<{ orders: { status: string }[] }>({
    queryKey: ['orders-all', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/orders?merchantId=${encodeURIComponent(merchantId)}&limit=100`)
      if (!res.ok) return { orders: [] }
      return res.json()
    },
  })

  const pendingCount = (data?.orders ?? []).filter(o => o.status === 'PENDING').length

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
            <div className="tab-badge-wrap">
              <Icon size={22} strokeWidth={active === id ? 2.2 : 1.8} />
              {id === '/orders' && pendingCount > 0 && (
                <span className="tab-badge">{pendingCount > 9 ? '9+' : pendingCount}</span>
              )}
            </div>
          </div>
          <span className="tlab">{label}</span>
        </button>
      ))}
    </nav>
  )
}
