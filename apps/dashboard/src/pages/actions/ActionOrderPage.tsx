import { useState, useEffect } from 'react'
import { useParams } from '@tanstack/react-router'

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

  return (
    <div style={pageStyle}>
      {/* Logo */}
      <div style={logoStyle}>
        <img src="/mark-tile.svg" width="32" height="32" alt="" />
        <span style={{ fontFamily: "'Newsreader', Georgia, serif", fontWeight: 600 }}>Mesa</span>
      </div>

      <div className="card" style={cardStyle}>
        {state === 'loading' && (
          <p style={{ color: 'var(--smoke)', textAlign: 'center', padding: '2rem 0' }}>Loading order...</p>
        )}

        {state === 'not_found' && (
          <EmptyState icon="?" title="Link not found" body="This order link does not exist or has been removed." />
        )}

        {state === 'expired' && (
          <EmptyState icon="⏱" title="Link expired" body="This order link has expired. Check Mesa for the latest order status." />
        )}

        {state === 'error' && (
          <EmptyState icon="!" title="Something went wrong" body="Could not load this order. Please try again later." />
        )}

        {state === 'already_actioned' && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div style={successBadgeStyle}>
              <CheckIcon />
              Already actioned
            </div>
            {resolution && (
              <p style={{ fontSize: '0.9rem', color: 'var(--ink)' }}>
                Resolution: <strong>{resolution}</strong>
              </p>
            )}
            {resolvedAt && (
              <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>
                {new Date(resolvedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        {state === 'done' && (
          <div style={{ display: 'grid', gap: '0.75rem', textAlign: 'center' }}>
            <div style={{ ...successBadgeStyle, justifyContent: 'center' }}>
              <CheckIcon />
              {doneMessage}
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--smoke)' }}>You can close this tab.</p>
          </div>
        )}

        {state === 'loaded' && task && (
          <div style={{ display: 'grid', gap: '1.25rem' }}>
            <div>
              <p style={sectionLabel}>New Order</p>
              <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ink)', margin: '0 0 0.25rem' }}>
                {task.payload.customerPhone ?? 'Unknown customer'}
              </h2>
            </div>

            {task.payload.items && task.payload.items.length > 0 && (
              <div>
                <p style={sectionLabel}>Items</p>
                <div style={{ display: 'grid', gap: '0.375rem' }}>
                  {task.payload.items.map((item, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', color: 'var(--ink)' }}>
                      <span>
                        {item.quantity ? `${item.quantity}x ` : ''}{item.productName}
                      </span>
                      {(item.agreedPrice ?? item.unitPrice) != null && (
                        <span>₦{((item.agreedPrice ?? item.unitPrice ?? 0) * item.quantity).toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {task.payload.agreedTotal != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.9375rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                <span>Agreed total</span>
                <span>₦{task.payload.agreedTotal.toLocaleString()}</span>
              </div>
            )}

            {task.payload.notes && (
              <div>
                <p style={sectionLabel}>Notes</p>
                <p style={{ fontSize: '0.875rem', color: 'var(--ink)', margin: 0, whiteSpace: 'pre-wrap' }}>{task.payload.notes}</p>
              </div>
            )}

            {actionError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{actionError}</p>
            )}

            {editing ? (
              <form onSubmit={handleEdit} style={{ display: 'grid', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', color: 'var(--ink)', marginBottom: '0.375rem' }}>
                    Customer phone
                  </label>
                  <input
                    className="input"
                    type="text"
                    value={editPhone}
                    onChange={e => setEditPhone(e.target.value)}
                    placeholder="Customer phone"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', color: 'var(--ink)', marginBottom: '0.375rem' }}>
                    Items
                  </label>
                  <div style={{ display: 'grid', gap: '0.375rem' }}>
                    {editItems.map((item, i) => (
                      <div key={i} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                        <input
                          className="input"
                          type="text"
                          value={item.productName}
                          onChange={e => updateItem(i, 'productName', e.target.value)}
                          placeholder="Product name"
                          style={{ width: '40%', boxSizing: 'border-box' }}
                        />
                        <input
                          className="input"
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={e => updateItem(i, 'quantity', parseInt(e.target.value, 10) || 1)}
                          placeholder="Qty"
                          style={{ width: '20%', boxSizing: 'border-box' }}
                        />
                        <input
                          className="input"
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.unitPrice ?? ''}
                          onChange={e => updateItem(i, 'unitPrice', parseFloat(e.target.value))}
                          placeholder="Unit price"
                          style={{ width: '25%', boxSizing: 'border-box' }}
                        />
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => removeItem(i)}
                          style={{ padding: '0 0.5rem', flexShrink: 0 }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={addItem}
                      style={{ justifyContent: 'flex-start', fontSize: '0.875rem' }}
                    >
                      + Add item
                    </button>
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', color: 'var(--ink)', marginBottom: '0.375rem' }}>
                    Agreed total (₦)
                  </label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={editTotal}
                    onChange={e => setEditTotal(e.target.value)}
                    placeholder="Enter agreed total"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    autoFocus
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', color: 'var(--ink)', marginBottom: '0.375rem' }}>
                    Notes
                  </label>
                  <textarea
                    className="input"
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="Notes"
                    rows={3}
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.625rem' }}>
                  <button type="submit" className="btn-primary" disabled={actionLoading} style={{ flex: 1, justifyContent: 'center' }}>
                    {actionLoading ? 'Saving...' : 'Confirm Edit'}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => { setEditing(false); setActionError('') }} style={{ flex: 1, justifyContent: 'center' }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ display: 'grid', gap: '0.625rem' }}>
                <button
                  className="btn-primary"
                  onClick={() => void doAction('accept')}
                  disabled={actionLoading}
                  style={{ justifyContent: 'center' }}
                >
                  {actionLoading ? 'Processing...' : 'Accept Order'}
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditing(true)
                    setEditPhone(task.payload.customerPhone ?? '')
                    setEditItems((task.payload.items ?? []).map(i => ({ ...i })))
                    setEditTotal(task.payload.agreedTotal?.toString() ?? '')
                    setEditNotes(task.payload.notes ?? '')
                  }}
                  disabled={actionLoading}
                  style={{ justifyContent: 'center' }}
                >
                  Edit Order
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => void doAction('reject')}
                  disabled={actionLoading}
                  style={{ justifyContent: 'center', color: 'var(--danger)' }}
                >
                  Reject Order
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" style={{ width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '1rem 0' }}>
      <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>{icon}</div>
      <p style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.375rem' }}>{title}</p>
      <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', lineHeight: 1.5 }}>{body}</p>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  padding: '2rem 1rem',
  background: 'var(--bg)',
}

const logoStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '2rem',
  fontWeight: 700,
  fontSize: '1.25rem',
  color: 'var(--ink)',
}

const logoIconStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: 'var(--forest)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  fontWeight: 800,
  fontSize: '1rem',
}

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 480,
  padding: '1.75rem',
}

const sectionLabel: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: 'var(--smoke)',
  margin: '0 0 0.375rem',
}

const successBadgeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  color: '#25D366',
  fontWeight: 600,
  fontSize: '0.9375rem',
}
