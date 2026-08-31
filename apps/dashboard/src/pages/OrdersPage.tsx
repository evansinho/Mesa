import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
import { OrderCard, ChannelBadge, type Order } from '../components/ui/OrderCard'
import { StatusBadge } from '../components/ui/StatusBadge'
import { naira } from '../components/ui/HeroCard'
import { useOverlay } from '../context/OverlayContext'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'
import { todayDateString, addDays } from '../lib/dates'

const FILTERS = [
  { id: 'all',             label: 'All',              status: '' },
  { id: 'pending',         label: 'Pending',          status: 'PENDING' },
  { id: 'confirmed',       label: 'Confirmed',        status: 'CONFIRMED' },
  { id: 'awaiting',        label: 'Awaiting payment', status: 'AWAITING_PAYMENT' },
  { id: 'paid',            label: 'Paid',             status: 'PAID' },
  { id: 'fulfilled',       label: 'Fulfilled',        status: 'FULFILLED' },
  { id: 'cancelled',       label: 'Cancelled',        status: 'CANCELLED' },
]

const CHANNEL_FILTERS = [
  { id: 'all',       label: 'All channels', channel: '',          color: undefined },
  { id: 'whatsapp',  label: 'WhatsApp',      channel: 'whatsapp',  color: '#25D366' },
  { id: 'instagram', label: 'Instagram',     channel: 'instagram', color: '#E1306C' },
] as const

const DATE_FILTERS = [
  { id: 'all',    label: 'All time' },
  { id: 'today',  label: 'Today' },
  { id: 'week',   label: 'This week' },
  { id: 'month',  label: 'This month' },
  { id: 'custom', label: 'Custom range' },
] as const

// Resolves a date-filter selection to from/to (YYYY-MM-DD, inclusive) sent
// straight to the server — the server, not the browser, now decides which
// orders match, so a range that reaches further back than whatever's
// already loaded on the page is never silently missed.
function resolveDateRange(
  filter: typeof DATE_FILTERS[number]['id'],
  custom: { from: string; to: string },
): { from?: string; to?: string } {
  const today = todayDateString()
  if (filter === 'today') return { from: today, to: today }
  if (filter === 'week') return { from: addDays(today, -6), to: today }
  if (filter === 'month') return { from: addDays(today, -29), to: today }
  if (filter === 'custom') return { from: custom.from, to: custom.to }
  return {}
}

function dateGroupLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This week'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Older']

function initials(o: Order) {
  const n = o.customerName ?? o.customerPhone
  const parts = n.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^\d/.test(parts[0])) return parts[0].slice(-2)
  return parts.map((p: string) => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function relDate(iso: string) {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const diffH = Math.floor(diffMs / 3600_000)
  if (diffH < 24) return diffH < 1 ? 'Just now' : `${diffH}h ago`
  if (diffH < 48) return 'Yesterday'
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

function itemSummary(items: Order['items']) {
  if (items.length === 0) return '—'
  const first = `${items[0].quantity}× ${items[0].productName}`
  if (items.length === 1) return first
  return `${first} +${items.length - 1} more`
}

export default function OrdersPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const qc = useQueryClient()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()
  const [filter, setFilter] = useState('all')
  const [channelFilter, setChannelFilter] = useState<typeof CHANNEL_FILTERS[number]['id']>('all')
  const [dateFilter, setDateFilter] = useState<typeof DATE_FILTERS[number]['id']>('all')
  const [customFrom, setCustomFrom] = useState(todayDateString)
  const [customTo, setCustomTo] = useState(todayDateString)
  const [search, setSearch] = useState('')

  const { from, to } = resolveDateRange(dateFilter, { from: customFrom, to: customTo })
  // A custom range needs both dates and from <= to before it's worth
  // asking the server — otherwise fall back to the unfiltered fetch rather
  // than sending a request that would just 400.
  const rangeReady = dateFilter !== 'custom' || (!!customFrom && !!customTo && customFrom <= customTo)

  const { data, isLoading } = useQuery<{ orders: Order[] }>({
    queryKey: ['orders-all', merchantId, from, to],
    enabled: !!merchantId && rangeReady,
    queryFn: async () => {
      const params = new URLSearchParams({ merchantId, limit: '200' })
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const res = await apiFetch(`/orders?${params.toString()}`)
      if (!res.ok) return { orders: [] }
      return res.json()
    },
  })

  const allOrders = data?.orders ?? []

  const activeChannel = CHANNEL_FILTERS.find(c => c.id === channelFilter)!

  // Status pill counts reflect the channel filter too, so the numbers stay
  // meaningful as it narrows the list down — but not the search box or the
  // status filter itself, since that's what the pills represent. The date
  // filter is applied server-side now (see the query above), not here.
  const scopedOrders = useMemo(() => {
    if (!activeChannel.channel) return allOrders
    return allOrders.filter(o => o.conversation?.channel === activeChannel.channel)
  }, [allOrders, activeChannel.channel])

  const counts: Record<string, number> = {
    all: scopedOrders.length,
    pending: scopedOrders.filter(o => o.status === 'PENDING').length,
    confirmed: scopedOrders.filter(o => o.status === 'CONFIRMED').length,
    awaiting: scopedOrders.filter(o => o.status === 'AWAITING_PAYMENT').length,
    paid: scopedOrders.filter(o => o.status === 'PAID').length,
    fulfilled: scopedOrders.filter(o => o.status === 'FULFILLED').length,
    cancelled: scopedOrders.filter(o => o.status === 'CANCELLED').length,
  }

  const activeFilter = FILTERS.find(f => f.id === filter)!
  const q = search.toLowerCase().trim()

  const displayOrders = useMemo(() => {
    let list = activeFilter.status
      ? scopedOrders.filter(o => o.status === activeFilter.status)
      : scopedOrders
    if (q) {
      list = list.filter(o =>
        (o.customerName ?? '').toLowerCase().includes(q) ||
        o.customerPhone.includes(q) ||
        o.items.some(i => i.productName.toLowerCase().includes(q))
      )
    }
    return list
  }, [scopedOrders, activeFilter.status, q])

  const grouped = useMemo(() => {
    const map: Record<string, Order[]> = {}
    for (const o of displayOrders) {
      const label = dateGroupLabel(o.createdAt)
      if (!map[label]) map[label] = []
      map[label].push(o)
    }
    return GROUP_ORDER.filter(g => map[g]).map(g => ({ label: g, orders: map[g] }))
  }, [displayOrders])

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/orders/${id}/confirm`, { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders-all', merchantId] })
      qc.invalidateQueries({ queryKey: ['orders-confirm', merchantId] })
      qc.invalidateQueries({ queryKey: ['analytics-summary', merchantId] })
      toast('Order confirmed · customer notified')
    },
  })

  return (
    <div className="pb-tab">
      <TopBar title="Orders" sub="Caught from your chats" />
      <div className="pills pills-wrap">
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={`pill${filter === f.id ? ' on' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}{counts[f.id] > 0 ? ` · ${counts[f.id]}` : ''}
          </button>
        ))}
      </div>
      <div className="pills pills-wrap" style={{ paddingTop: 0 }}>
        {CHANNEL_FILTERS.map(c => {
          const on = channelFilter === c.id
          return (
            <button
              key={c.id}
              className={`pill${on ? ' on' : ''}`}
              style={on && c.color ? { background: c.color, borderColor: c.color } : undefined}
              onClick={() => setChannelFilter(c.id)}
            >
              {c.label}
            </button>
          )
        })}
      </div>
      <div className="pad" style={{ paddingTop: 4 }}>
        <div className="orders-search">
          <Search size={16} strokeWidth={2} />
          <input
            type="text"
            placeholder="Search by name or product…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="orders-date-select"
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value as typeof dateFilter)}
            aria-label="Filter by date"
          >
            {DATE_FILTERS.map(d => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </div>
        {dateFilter === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={e => setCustomFrom(e.target.value)}
              className="date-input"
              style={{ border: '1px solid var(--line)' }}
            />
            <span className="muted" style={{ fontSize: 13 }}>to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={todayDateString()}
              onChange={e => setCustomTo(e.target.value)}
              className="date-input"
              style={{ border: '1px solid var(--line)' }}
            />
          </div>
        )}
      </div>
      {/* Mobile: grouped cards */}
      <div className="orders-cards pad" style={{ paddingTop: 4 }}>
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {!isLoading && displayOrders.length === 0 && (
          <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
            {q ? `No results for "${search}"` : 'Nothing here yet.'}
          </div>
        )}
        {grouped.map(({ label, orders }) => (
          <div key={label}>
            <div className="date-group-label">{label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 4 }}>
              {orders.map(o => (
                <OrderCard
                  key={o.id}
                  order={o}
                  onConfirm={id => confirmMutation.mutate(id)}
                  onOpen={id => openOverlay({ type: 'order-detail', orderId: id })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: table view */}
      <div className="orders-table pad" style={{ paddingTop: 4 }}>
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {!isLoading && displayOrders.length === 0 && (
          <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
            {q ? `No results for "${search}"` : 'Nothing here yet.'}
          </div>
        )}
        {!isLoading && displayOrders.length > 0 && (
          <div className="ot-wrap">
            <div className="ot-head">
              <div>Customer</div>
              <div>Items</div>
              <div>Total</div>
              <div>Status</div>
              <div>Date</div>
            </div>
            <div>
              {displayOrders.map(o => (
                <div
                  key={o.id}
                  className="ot-row"
                  onClick={() => openOverlay({ type: 'order-detail', orderId: o.id })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && openOverlay({ type: 'order-detail', orderId: o.id })}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div className="ot-av">{initials(o)}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ot-name">{o.customerName ?? o.customerPhone}</div>
                      <div style={{ marginTop: 2 }}>
                        <ChannelBadge channel={o.conversation?.channel} />
                      </div>
                    </div>
                  </div>
                  <div className="ot-cell" style={{ color: 'var(--muted)' }}>{itemSummary(o.items)}</div>
                  <div className="ot-total">{naira(parseFloat(o.total))}</div>
                  <div className="ot-cell"><StatusBadge status={o.status} /></div>
                  <div className="ot-cell" style={{ color: 'var(--muted)', fontFamily: 'var(--fm)', fontSize: 12.5 }}>{relDate(o.createdAt)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
