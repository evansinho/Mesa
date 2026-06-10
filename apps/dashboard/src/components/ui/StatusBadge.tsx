import { Badge } from './Badge'

const STATUS_MAP: Record<string, { tone: 'mint' | 'amber' | 'ink' | 'danger' | 'subtle'; label: string }> = {
  PENDING:          { tone: 'amber',  label: 'To confirm' },
  CONFIRMED:        { tone: 'ink',    label: 'Confirmed' },
  AWAITING_PAYMENT: { tone: 'amber',  label: 'Awaiting payment' },
  PAID:             { tone: 'mint',   label: 'Paid' },
  FULFILLED:        { tone: 'mint',   label: 'Fulfilled' },
  CANCELLED:        { tone: 'danger', label: 'Cancelled' },
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status] ?? { tone: 'subtle' as const, label: status.toLowerCase() }
  return <Badge tone={s.tone} dot>{s.label}</Badge>
}
