import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { BackBar } from './ui/BackBar'
import { StatusBadge } from './ui/StatusBadge'
import { Btn } from './ui/Btn'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'
import { useToast } from '../context/ToastContext'
import { naira } from './ui/HeroCard'
import { ChannelBadge } from './ui/OrderCard'

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^\d/.test(parts[0])) return parts[0].slice(-2)
  return parts.map(p => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('234')) {
    return `+234 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`
  }
  return phone
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
}

type ConvMessage = { id: string; role: 'inbound' | 'outbound'; body: string; createdAt: string }

type OrderData = {
  id: string
  customerPhone: string
  customerName?: string | null
  status: string
  total: string
  createdAt: string
  conversationId?: string | null
  conversation?: { channel: string } | null
  items: { id: string; productName: string; quantity: number; agreedPrice: string }[]
}

type Props = { orderId: string; onBack: () => void }

export function OrderDetail({ orderId, onBack }: Props) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const { data: order, isLoading } = useQuery<{ order: OrderData }>({
    queryKey: ['order', orderId],
    queryFn: async () => {
      const res = await apiFetch(`/orders/${orderId}`)
      if (!res.ok) throw new Error('Failed to load order')
      return res.json()
    },
  })

  const { data: convData } = useQuery<{ messages: ConvMessage[] }>({
    queryKey: ['conversation', order?.order.conversationId],
    enabled: !!order?.order.conversationId,
    queryFn: async () => {
      const res = await apiFetch(`/conversations/${order!.order.conversationId}/messages?limit=8`)
      if (!res.ok) return { messages: [] }
      return res.json()
    },
  })

  const [confirmed, setConfirmed] = useState(false)
  const confirm = useMutation({
    mutationFn: () => apiFetch(`/orders/${orderId}/confirm`, { method: 'PATCH' }),
    onSuccess: () => {
      setConfirmed(true)
      qc.invalidateQueries({ queryKey: ['orders', merchantId] })
      qc.invalidateQueries({ queryKey: ['orders-confirm', merchantId] })
      qc.invalidateQueries({ queryKey: ['analytics-summary', merchantId] })
      toast('Order confirmed · customer notified')
    },
  })

  const o = order?.order
  const isPending = o?.status === 'PENDING' && !confirmed
  const displayStatus = confirmed ? 'CONFIRMED' : (o?.status ?? 'PENDING')

  const steps = o ? [
    { t: 'Order detected', s: formatTime(o.createdAt), done: true },
    { t: 'Confirmed by you', s: !isPending ? 'Done' : 'Waiting', done: !isPending, cur: isPending },
    { t: 'Payment received', s: ['PAID', 'FULFILLED'].includes(o.status) ? 'Paid' : 'Pending', done: ['PAID', 'FULFILLED'].includes(o.status) },
    { t: 'Delivered', s: o.status === 'FULFILLED' ? 'Done' : '—', done: o.status === 'FULFILLED' },
  ] : []

  const messages = convData?.messages ?? []
  const name = o ? (o.customerName ?? formatPhone(o.customerPhone)) : ''
  const firstItem = o?.items[0]

  return (
    <>
      <div className="od-backdrop" onClick={onBack} />
      <div className="overlay od-panel">
        <BackBar
          onBack={onBack}
          title="Order"
          right={o ? <StatusBadge status={displayStatus} /> : undefined}
        />
        <div className="screen-scroll pad" style={{ paddingBottom: 110 }}>
          {isLoading && (
            <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--subtle)' }}>Loading…</div>
          )}
          {o && (
            <>
              {/* summary card */}
              <div className="card card-lg card-pad fade-up">
                <div className="flex aic gap12">
                  <div className="o-av" style={{ width: 46, height: 46, fontSize: 17, borderRadius: 13 }}>{initials(name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                    <div className="mono muted" style={{ fontSize: 11.5, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>#{o.id.slice(-5).toUpperCase()}</span>
                      <ChannelBadge channel={o.conversation?.channel ?? 'whatsapp'} />
                    </div>
                  </div>
                </div>
                {(o.conversation?.channel ?? 'whatsapp') === 'whatsapp' && (
                  <a
                    href={`https://wa.me/${o.customerPhone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wa-msg-btn"
                    style={{ marginTop: 12, marginBottom: 0 }}
                  >
                    <MessageCircle size={14} strokeWidth={2} />
                    Message on WhatsApp
                  </a>
                )}
                {firstItem && (
                  <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{firstItem.productName}</div>
                      <div className="mono subtle" style={{ fontSize: 12, marginTop: 4 }}>Qty · {firstItem.quantity}</div>
                    </div>
                    <div className="naira" style={{ fontSize: 30, whiteSpace: 'nowrap' }}>{naira(Number(o.total))}</div>
                  </div>
                )}
              </div>

              {/* WhatsApp transcript */}
              {messages.length > 0 && (
                <>
                  <div className="sec-head">
                    <span className="st">How Mesa caught it</span>
                    <span className="badge badge-mint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      ⚡ Auto-detected
                    </span>
                  </div>
                  <div className="card card-pad fade-up" style={{ background: '#ece5da', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {messages.slice(-5).map(m => (
                      <div key={m.id} style={{
                        alignSelf: m.role === 'outbound' ? 'flex-end' : 'flex-start',
                        maxWidth: '82%',
                        background: m.role === 'outbound' ? '#e7f6d8' : '#fff',
                        color: 'var(--ink)',
                        padding: '9px 13px',
                        borderRadius: 13,
                        borderTopLeftRadius: m.role === 'outbound' ? 13 : 4,
                        borderTopRightRadius: m.role === 'outbound' ? 4 : 13,
                        fontSize: 14,
                        lineHeight: 1.35,
                        boxShadow: '0 1px 1px rgba(0,0,0,.06)',
                      }}>
                        {m.body}
                      </div>
                    ))}
                    <div style={{ alignSelf: 'stretch', marginTop: 4, background: 'var(--deep)', color: '#fff', borderRadius: 12, padding: '11px 13px', border: '1px solid rgba(43,212,138,.4)' }}>
                      <div style={{ fontFamily: 'var(--fm)', fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--mint)' }}>Mesa read the agreed price</div>
                      {firstItem && (
                        <div style={{ fontSize: 14, marginTop: 5 }}>{firstItem.productName} · <b style={{ color: 'var(--mint)' }}>{naira(Number(o.total))}</b></div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* timeline */}
              <div className="sec-head"><span className="st">Status</span></div>
              <div className="card card-pad fade-up">
                <div className="tl">
                  {steps.map((st, i) => (
                    <div key={i} className={`node${st.done ? ' done' : st.cur ? ' cur' : ''}`}>
                      <div className="t-t" style={{ color: st.done || st.cur ? 'var(--ink)' : 'var(--subtle)' }}>{st.t}</div>
                      <div className="t-s">{st.s}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {isPending && (
          <div className="footbar">
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn kind="ghost" size="lg" icon="pencil" onClick={() => toast('Edit price in chat')}>Edit</Btn>
              <Btn kind="mint" size="lg" block icon="check" loading={confirm.isPending} onClick={() => confirm.mutate()}>
                Confirm order
              </Btn>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
