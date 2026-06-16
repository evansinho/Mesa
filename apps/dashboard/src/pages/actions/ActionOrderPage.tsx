import { useState, useEffect } from 'react'
import { useParams } from '@tanstack/react-router'
import { Lockup } from '../../components/ui/Lockup'
import { Btn } from '../../components/ui/Btn'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

interface OrderItem {
  productName: string
  quantity: number
  unitPrice?: number
  agreedPrice?: number
}

interface OrderPayload {
  conversationId?: string
  customerPhone: string
  items?: OrderItem[]
  agreedTotal?: number
  notes?: string
}

interface OrderTask {
  id: string
  merchantId: string
  type: string
  payload: OrderPayload
}

type PageState = 'loading' | 'loaded' | 'done' | 'expired' | 'already_actioned' | 'not_found' | 'error'

export default function ActionOrderPage() {
  const { token } = useParams({ from: '/actions/order/$token' })
  const [state, setState] = useState<PageState>('loading')
  const [task, setTask] = useState<OrderTask | null>(null)
  const [resolution, setResolution] = useState('')
  const [resolvedAt, setResolvedAt] = useState('')
  const [editing, setEditing] = useState(false)
  const [editPhone, setEditPhone] = useState('')
  const [editItems, setEditItems] = useState<OrderItem[]>([])
  const [editTotal, setEditTotal] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  const [doneMessage, setDoneMessage] = useState('')

  useEffect(() => {
    void fetchOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function fetchOrder() {
    setState('loading')
    try {
      const res = await fetch(`${API_URL}/actions/order/${token}`)
      if (res.ok) {
        const data = await res.json() as { task: OrderTask }
        setTask(data.task)
        setState('loaded')
      } else if (res.status === 410) {
        setState('expired')
      } else if (res.status === 409) {
        const data = await res.json() as { resolution?: string; resolvedAt?: string }
        setResolution(data.resolution ?? '')
        setResolvedAt(data.resolvedAt ?? '')
        setState('already_actioned')
      } else if (res.status === 404) {
        setState('not_found')
      } else {
        setState('error')
      }
    } catch {
      setState('error')
    }
  }

  async function doAction(path: string, body?: Record<string, unknown>) {
    setActionLoading(true)
    setActionError('')
    try {
      const res = await fetch(`${API_URL}/actions/order/${token}/${path}`, {
        method: path === 'edit' ? 'PATCH' : 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const text = await res.text()
        setActionError(text || 'Action failed. Please try again.')
        return
      }
      if (path === 'accept') {
        setDoneMessage('Order accepted.')
        setState('done')
      } else if (path === 'reject') {
        setDoneMessage('Order rejected.')
        setState('done')
      } else if (path === 'edit') {
        setDoneMessage('Order updated and confirmed.')
        setState('done')
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setActionLoading(false)
    }
  }

  function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    void doAction('edit', {
      customerPhone: editPhone || undefined,
      items: editItems,
      agreedTotal: parseFloat(editTotal),
      notes: editNotes || undefined,
    })
  }

  function updateItem(index: number, field: keyof OrderItem, value: string | number) {
    setEditItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item))
  }

  function removeItem(index: number) {
    setEditItems(prev => prev.filter((_, i) => i !== index))
  }

  function addItem() {
    setEditItems(prev => [...prev, { productName: '', quantity: 1 }])
  }

  const noPrice = !task?.payload.agreedTotal || task.payload.agreedTotal <= 0

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2.5rem 1rem 4rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Lockup markSize={28} wordSize={22} />
      </div>

      <div className="card" style={{ width: '100%', maxWidth: 460, padding: '1.75rem 1.75rem 1.5rem' }}>

        {state === 'loading' && (
          <p className="muted" style={{ textAlign: 'center', padding: '2rem 0', fontSize: 15 }}>Loading order…</p>
        )}

        {state === 'not_found' && (
          <EmptyState icon="search" title="Link not found" body="This order link does not exist or has been removed." />
        )}

        {state === 'expired' && (
          <EmptyState icon="clock" title="Link expired" body="This order link has expired. Check Mesa for the latest order status." />
        )}

        {state === 'error' && (
          <EmptyState icon="alert-circle" title="Something went wrong" body="Could not load this order. Please try again later." />
        )}

        {state === 'already_actioned' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--mint-deep)', fontWeight: 600, fontSize: 15 }}>
              <CheckIcon />
              Already actioned
            </div>
            {resolution && (
              <p style={{ fontSize: 14, color: 'var(--ink)' }}>
                Resolution: <strong>{resolution}</strong>
              </p>
            )}
            {resolvedAt && (
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                {new Date(resolvedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        {state === 'done' && (
          <div style={{ display: 'grid', gap: 10, textAlign: 'center', padding: '1.5rem 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--mint-deep)', fontWeight: 700, fontSize: 16 }}>
              <CheckIcon />
              {doneMessage}
            </div>
            <p className="muted" style={{ fontSize: 14 }}>You can close this tab.</p>
          </div>
        )}

        {state === 'loaded' && task && (
          <div style={{ display: 'grid', gap: '1.5rem' }}>

            {/* Header */}
            <div>
              <div className="kicker">New Order</div>
              <h1 style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.03em', lineHeight: 1.1, marginTop: 8, color: 'var(--ink)' }}>
                {task.payload.customerPhone ?? 'Unknown customer'}
              </h1>
            </div>

            {/* Items */}
            {task.payload.items && task.payload.items.length > 0 && (
              <div>
                <div className="kicker" style={{ marginBottom: 10 }}>Items</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {task.payload.items.map((item, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15, color: 'var(--ink)' }}>
                      <span>{item.quantity ? `${item.quantity}× ` : ''}{item.productName}</span>
                      {(item.agreedPrice ?? item.unitPrice) != null && (
                        <span className="naira" style={{ fontSize: 14 }}>₦{((item.agreedPrice ?? item.unitPrice ?? 0) * item.quantity).toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Total */}
            {task.payload.agreedTotal != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 700, fontSize: 15.5, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                <span>Agreed total</span>
                <span className="naira" style={{ fontSize: 18, color: 'var(--forest)' }}>₦{task.payload.agreedTotal.toLocaleString()}</span>
              </div>
            )}

            {/* Notes */}
            {task.payload.notes && (
              <div>
                <div className="kicker" style={{ marginBottom: 6 }}>Notes</div>
                <p style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{task.payload.notes}</p>
              </div>
            )}

            {/* Error */}
            {actionError && <div className="alert-error" style={{ marginTop: 0 }}>{actionError}</div>}

            {/* Edit form */}
            {editing ? (
              <form onSubmit={handleEdit} style={{ display: 'grid', gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Customer phone</label>
                  <input className="input" type="text" value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="Customer phone" />
                </div>

                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Items</label>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {editItems.map((item, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input className="input" type="text" value={item.productName} onChange={e => updateItem(i, 'productName', e.target.value)} placeholder="Product name" style={{ flex: 2 }} />
                        <input className="input" type="number" min="1" value={item.quantity} onChange={e => updateItem(i, 'quantity', parseInt(e.target.value, 10) || 1)} placeholder="Qty" style={{ flex: 1 }} />
                        <input className="input" type="number" min="0" step="0.01" value={item.unitPrice ?? ''} onChange={e => updateItem(i, 'unitPrice', parseFloat(e.target.value))} placeholder="Price" style={{ flex: 1 }} />
                        <button type="button" onClick={() => removeItem(i)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
                      </div>
                    ))}
                    <button type="button" onClick={addItem} style={{ background: 'none', border: 'none', color: 'var(--mint-deep)', fontWeight: 600, fontSize: 14, cursor: 'pointer', textAlign: 'left', padding: '2px 0' }}>
                      + Add item
                    </button>
                  </div>
                </div>

                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Agreed total (₦)</label>
                  <input className="input" type="number" min="0" step="0.01" value={editTotal} onChange={e => setEditTotal(e.target.value)} placeholder="0" autoFocus />
                </div>

                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Notes</label>
                  <textarea className="input" value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Notes" rows={3} style={{ resize: 'vertical' }} />
                </div>

                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
                  <Btn type="submit" kind="primary" block loading={actionLoading}>Confirm Edit</Btn>
                  <Btn kind="ghost" block onClick={() => { setEditing(false); setActionError('') }}>Cancel</Btn>
                </div>
              </form>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {noPrice && (
                  <div style={{ background: 'var(--sand)', borderRadius: 'var(--r-md)', padding: '10px 14px', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.5 }}>
                    No price detected. Use <strong>Edit Order</strong> to set the agreed total before accepting.
                  </div>
                )}
                <Btn
                  kind="primary"
                  block
                  onClick={() => void doAction('accept')}
                  disabled={noPrice}
                  loading={actionLoading}
                >
                  Accept Order
                </Btn>
                <Btn
                  kind="ghost"
                  block
                  onClick={() => {
                    setEditing(true)
                    setEditPhone(task.payload.customerPhone ?? '')
                    setEditItems((task.payload.items ?? []).map(i => ({ ...i })))
                    setEditTotal(task.payload.agreedTotal?.toString() ?? '')
                    setEditNotes(task.payload.notes ?? '')
                  }}
                  disabled={actionLoading}
                >
                  Edit Order
                </Btn>
                <Btn
                  kind="ghost"
                  block
                  onClick={() => void doAction('reject')}
                  disabled={actionLoading}
                  style={{ color: 'var(--danger)' }}
                >
                  Reject Order
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" style={{ width: 18, height: 18, flexShrink: 0 }} fill="none" stroke="currentColor" strokeWidth={2.5}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  const icons: Record<string, React.ReactNode> = {
    search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
    clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    'alert-circle': <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  }
  return (
    <div style={{ textAlign: 'center', padding: '2rem 1rem' }}>
      <div style={{ width: 44, height: 44, margin: '0 auto 14px', color: 'var(--subtle)' }}>
        {icons[icon]}
      </div>
      <p style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 18, color: 'var(--ink)', letterSpacing: '-0.02em', marginBottom: 6 }}>{title}</p>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55 }}>{body}</p>
    </div>
  )
}
