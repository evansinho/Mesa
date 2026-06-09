import { useState, useEffect } from 'react'
import { useParams } from '@tanstack/react-router'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

interface PaymentTask {
  id: string
  orderRef?: string
  customerName?: string
  customerPhone?: string
  expectedAmount?: number
  receivedAmount?: number
  screenshotUrl?: string
  ocrConfidence?: number
  reason?: string
  status?: string
  resolvedAt?: string
  resolution?: string
}

type PageState = 'loading' | 'loaded' | 'done' | 'expired' | 'already_actioned' | 'not_found' | 'error'

export default function ActionPaymentPage() {
  const { token } = useParams({ from: '/actions/payment/$token' })
  const [state, setState] = useState<PageState>('loading')
  const [task, setTask] = useState<PaymentTask | null>(null)
  const [resolution, setResolution] = useState('')
  const [resolvedAt, setResolvedAt] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  const [doneMessage, setDoneMessage] = useState('')

  useEffect(() => {
    void fetchPayment()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function fetchPayment() {
    setState('loading')
    try {
      const res = await fetch(`${API_URL}/actions/payment/${token}`)
      if (res.ok) {
        const data = await res.json() as { task: PaymentTask }
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

  async function doAction(action: 'confirm' | 'request-balance' | 'dispute') {
    setActionLoading(true)
    setActionError('')
    try {
      const res = await fetch(`${API_URL}/actions/payment/${token}/${action}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const text = await res.text()
        setActionError(text || 'Action failed. Please try again.')
        return
      }
      if (action === 'confirm') setDoneMessage('Payment confirmed.')
      else if (action === 'request-balance') setDoneMessage('Balance request sent to customer.')
      else if (action === 'dispute') setDoneMessage('Payment disputed.')
      setState('done')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setActionLoading(false)
    }
  }

  function reasonLabel(reason?: string): string | null {
    if (!reason) return null
    const map: Record<string, string> = {
      low_confidence: 'Low OCR confidence',
      amount_mismatch: 'Amount does not match',
      reference_reused: 'Payment reference already used',
      mono_required: 'Bank not connected (Mono required)',
      mono_failed: 'Bank connection check failed',
    }
    return map[reason] ?? reason
  }

  return (
    <div style={pageStyle}>
      {/* Logo */}
      <div style={logoStyle}>
        <div style={logoIconStyle}>M</div>
        Mesa
      </div>

      <div className="card" style={cardStyle}>
        {state === 'loading' && (
          <p style={{ color: 'var(--smoke)', textAlign: 'center', padding: '2rem 0' }}>Loading payment...</p>
        )}

        {state === 'not_found' && (
          <EmptyState icon="?" title="Link not found" body="This payment link does not exist or has been removed." />
        )}

        {state === 'expired' && (
          <EmptyState icon="⏱" title="Link expired" body="This payment link has expired. Check Mesa for the latest payment status." />
        )}

        {state === 'error' && (
          <EmptyState icon="!" title="Something went wrong" body="Could not load this payment. Please try again later." />
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
              <p style={sectionLabel}>Payment Review</p>
              <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ink)', margin: '0 0 0.25rem' }}>
                {task.orderRef ? `Order ${task.orderRef}` : 'Payment'}
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', margin: 0 }}>
                {task.customerName ?? task.customerPhone ?? 'Unknown customer'}
                {task.customerName && task.customerPhone ? ` · ${task.customerPhone}` : ''}
              </p>
            </div>

            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {task.expectedAmount != null && (
                <div style={rowStyle}>
                  <span style={{ color: 'var(--smoke)', fontSize: '0.875rem' }}>Expected</span>
                  <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>₦{task.expectedAmount.toLocaleString()}</span>
                </div>
              )}
              {task.receivedAmount != null && (
                <div style={rowStyle}>
                  <span style={{ color: 'var(--smoke)', fontSize: '0.875rem' }}>Received (OCR)</span>
                  <span style={{
                    fontWeight: 600,
                    fontSize: '0.9375rem',
                    color: task.expectedAmount != null && task.receivedAmount < task.expectedAmount ? 'var(--danger)' : 'var(--ink)',
                  }}>
                    ₦{task.receivedAmount.toLocaleString()}
                  </span>
                </div>
              )}
              {task.ocrConfidence != null && (
                <div style={rowStyle}>
                  <span style={{ color: 'var(--smoke)', fontSize: '0.875rem' }}>OCR confidence</span>
                  <span style={{ fontSize: '0.875rem', color: task.ocrConfidence < 0.7 ? 'var(--danger)' : 'var(--ink)' }}>
                    {Math.round(task.ocrConfidence * 100)}%
                  </span>
                </div>
              )}
            </div>

            {task.reason && (
              <div style={{
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 8,
                padding: '0.75rem',
                fontSize: '0.875rem',
                color: 'var(--danger)',
                lineHeight: 1.5,
              }}>
                {reasonLabel(task.reason)}
                {task.reason === 'mono_required' && (
                  <span style={{ color: 'var(--smoke)', display: 'block', marginTop: '0.25rem' }}>
                    Connect your bank via Mono to auto-confirm future payments.
                  </span>
                )}
              </div>
            )}

            {task.screenshotUrl && (
              <div>
                <p style={sectionLabel}>Payment screenshot</p>
                <img
                  src={task.screenshotUrl}
                  alt="Payment screenshot"
                  style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', objectFit: 'contain', maxHeight: 240 }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            )}

            {actionError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{actionError}</p>
            )}

            <div style={{ display: 'grid', gap: '0.625rem' }}>
              <button
                className="btn-primary"
                onClick={() => void doAction('confirm')}
                disabled={actionLoading}
                style={{ justifyContent: 'center' }}
              >
                {actionLoading ? 'Processing...' : 'Confirm Payment'}
              </button>
              <button
                className="btn-ghost"
                onClick={() => void doAction('request-balance')}
                disabled={actionLoading}
                style={{ justifyContent: 'center' }}
              >
                Request Balance
              </button>
              <button
                className="btn-ghost"
                onClick={() => void doAction('dispute')}
                disabled={actionLoading}
                style={{ justifyContent: 'center', color: 'var(--danger)' }}
              >
                Dispute
              </button>
            </div>
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

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}
