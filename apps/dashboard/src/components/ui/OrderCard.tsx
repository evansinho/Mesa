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
}

function initials(name: string) {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)
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
          <div className="o-meta">#{order.id.slice(-5).toUpperCase()} · {timeLabel(order.createdAt)}</div>
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
