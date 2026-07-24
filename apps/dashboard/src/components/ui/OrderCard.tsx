import { useState } from 'react'
import { Package } from 'lucide-react'
import { Btn } from './Btn'
import { StatusBadge } from './StatusBadge'
import { naira } from './HeroCard'

export type Order = {
  id: string
  customerPhone: string
  customerName?: string | null
  status: string
  total: string
  createdAt: string
  items: { id: string; productName: string; quantity: number; agreedPrice: string; unitPrice?: string }[]
  conversationId?: string | null
  conversation?: { channel: string } | null
}

const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram' }
const CHANNEL_COLOR: Record<string, string> = { whatsapp: '#25D366', instagram: '#E1306C' }

export function ChannelBadge({ channel }: { channel?: string | null }) {
  if (!channel || !CHANNEL_LABEL[channel]) return null
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: '0.7rem', fontWeight: 600, color: CHANNEL_COLOR[channel],
      background: `${CHANNEL_COLOR[channel]}1a`, borderRadius: 999,
      padding: '0.15rem 0.5rem', lineHeight: 1.4,
    }}>
      {CHANNEL_LABEL[channel]}
    </span>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^\d/.test(parts[0])) return parts[0].slice(-2)
  return parts.map(p => p[0]).join('').toUpperCase().slice(0, 2) || '?'
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
}

type Props = {
  order: Order
  onConfirm: (id: string) => void
  onOpen: (id: string) => void
  compact?: boolean
}

export function OrderCard({ order, onConfirm, onOpen }: Props) {
  const [confirming, setConfirming] = useState(false)
  const name = order.customerName ?? order.customerPhone
  const firstItem = order.items[0]
  const isPending = order.status === 'PENDING'

  const handleConfirm = () => {
    setConfirming(true)
    onConfirm(order.id)
  }

  return (
    <div className={`order fade-up${confirming ? ' confirming' : ''}`} onClick={() => onOpen(order.id)}>
      <div className="o-top">
        <div className="o-av">{initials(name)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="o-name">{name}</div>
          <div className="o-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>#{order.id.slice(-5).toUpperCase()} · {timeLabel(order.createdAt)}</span>
            <ChannelBadge channel={order.conversation?.channel} />
          </div>
        </div>
        <div className="o-amt">
          <div className="a">{naira(Number(order.total))}</div>
        </div>
      </div>
      {firstItem && (
        <div className="o-item">
          <Package size={14} strokeWidth={2} color="var(--subtle)" />
          <b>{firstItem.quantity} × {firstItem.productName}</b>
        </div>
      )}
      {isPending ? (
        <div className="o-actions" onClick={e => e.stopPropagation()}>
          <Btn kind="mint" size="md" block icon="check" onClick={handleConfirm} loading={confirming}>Confirm</Btn>
          <Btn kind="ghost" size="md" icon="pencil" onClick={() => onOpen(order.id)}>Edit</Btn>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <StatusBadge status={order.status} />
        </div>
      )}
    </div>
  )
}
