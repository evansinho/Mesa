import { useState, useEffect } from 'react'
import { useParams } from '@tanstack/react-router'
import { Lockup } from '../../components/ui/Lockup'
import { Btn } from '../../components/ui/Btn'

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

  async function doAction(action: 'confirm' | 'not-yet' | 'request-balance' | 'dispute') {
    setActionLoading(true)
    setActionError('')
    try {
      const res = await fetch(`${API_URL}/actions/payment/${token}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const text = await res.text()
        setActionError(text || 'Action failed. Please try again.')
        return
      }
      if (action === 'confirm') setDoneMessage('Payment confirmed.')
      else if (action === 'not-yet') setDoneMessage('Okay. Mesa will check again later.')
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
      mono_transaction_already_claimed: 'Bank transaction already matched to another order',
      mono_error: 'Bank verification service could not be reached',
    }
    return map[reason] ?? reason
  }

  const amountMismatch = task?.expectedAmount != null && task?.receivedAmount != null && task.receivedAmount < task.expectedAmount

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2.5rem 1rem 4rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Lockup markSize={28} wordSize={22} />
      </div>

      <div className="card" style={{ width: '100%', maxWidth: 460, padding: '1.75rem 1.75rem 1.5rem' }}>

        {state === 'loading' && (
          <p className="muted" style={{ textAlign: 'center', padding: '2rem 0', fontSize: 15 }}>Loading payment…</p>
        )}

        {state === 'not_found' && (
          <EmptyState icon="search" title="Link not found" body="This payment link does not exist or has been removed." />
        )}

        {state === 'expired' && (
          <EmptyState icon="clock" title="Link expired" body="This payment link has expired. Check Mesa for the latest payment status." />
        )}

        {state === 'error' && (
          <EmptyState icon="alert-circle" title="Something went wrong" body="Could not load this payment. Please try again later." />
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
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>{new Date(resolvedAt).toLocaleString()}</p>
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
              <div className="kicker">Payment Review</div>
              <h1 style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.03em', lineHeight: 1.1, marginTop: 8, color: 'var(--ink)' }}>
                {task.orderRef ? `Order ${task.orderRef}` : 'Payment'}
              </h1>
              {(task.customerName ?? task.customerPhone) && (
                <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                  {task.customerName ?? task.customerPhone}
                  {task.customerName && task.customerPhone ? ` · ${task.customerPhone}` : ''}
                </p>
              )}
            </div>

            {/* Amounts */}
            {(task.expectedAmount != null || task.receivedAmount != null) && (
              <div style={{ display: 'grid', gap: 8 }}>
                {task.expectedAmount != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15 }}>
                    <span className="muted">Expected</span>
                    <span className="naira" style={{ fontWeight: 600, fontSize: 15 }}>₦{task.expectedAmount.toLocaleString()}</span>
                  </div>
                )}
                {task.receivedAmount != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15 }}>
                    <span className="muted">Received (OCR)</span>
                    <span className="naira" style={{ fontWeight: 600, fontSize: 15, color: amountMismatch ? 'var(--danger)' : 'var(--ink)' }}>
                      ₦{task.receivedAmount.toLocaleString()}
                    </span>
                  </div>
                )}
                {task.ocrConfidence != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 14 }}>
                    <span className="muted">OCR confidence</span>
                    <span style={{ color: task.ocrConfidence < 0.7 ? 'var(--danger)' : 'var(--muted)' }}>
                      {Math.round(task.ocrConfidence * 100)}%
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Flag reason */}
            {task.reason && (
              <div style={{ background: 'rgba(192,73,47,.07)', border: '1px solid rgba(192,73,47,.18)', borderRadius: 'var(--r-md)', padding: '12px 14px', fontSize: 14, color: 'var(--danger)', lineHeight: 1.5 }}>
                {reasonLabel(task.reason)}
                {task.reason === 'mono_required' && (
                  <span className="muted" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
                    Connect your bank via Mono to auto-confirm future payments.
                  </span>
                )}
              </div>
            )}

            {/* Screenshot */}
            {task.screenshotUrl && (
              <div>
                <div className="kicker" style={{ marginBottom: 8 }}>Payment screenshot</div>
                <img
                  src={task.screenshotUrl}
                  alt="Payment screenshot"
                  style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', objectFit: 'contain', maxHeight: 240 }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            )}

            {/* Error */}
            {actionError && <div className="alert-error" style={{ marginTop: 0 }}>{actionError}</div>}

            {/* Actions */}
            <div style={{ display: 'grid', gap: 10 }}>
              <Btn kind="primary" block onClick={() => void doAction('confirm')} loading={actionLoading}>
                Confirm Payment
              </Btn>
              <Btn kind="ghost" block onClick={() => void doAction('not-yet')} disabled={actionLoading}>
                Not Yet
              </Btn>
              <Btn kind="ghost" block onClick={() => void doAction('dispute')} disabled={actionLoading} style={{ color: 'var(--danger)' }}>
                Dispute
              </Btn>
            </div>
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
