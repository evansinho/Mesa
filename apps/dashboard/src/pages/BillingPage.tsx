import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type BillingEvent = {
  id: string
  type: string
  createdAt: string
  metadata?: Record<string, unknown>
}

type SubscriptionState = {
  status: 'trialing' | 'active' | 'past_due' | 'expired' | 'cancelled'
  trialEndsAt: string
  daysRemaining: number
  plan: string
  currentPeriodEnd?: string
  email?: string | null
  needsEmail: boolean
  events: BillingEvent[]
}

function statusCopy(data?: SubscriptionState) {
  if (!data) return { title: 'Billing', detail: 'Loading billing status.' }
  if (data.status === 'trialing') return {
    title: `${data.daysRemaining} day${data.daysRemaining === 1 ? '' : 's'} left in trial`,
    detail: 'Subscribe before the trial ends to keep customer order automation running.',
  }
  if (data.status === 'active') return {
    title: 'Subscription active',
    detail: data.currentPeriodEnd
      ? `Next billing period ends ${new Date(data.currentPeriodEnd).toLocaleDateString('en-NG')}.`
      : 'Customer order automation is active.',
  }
  if (data.status === 'past_due') return { title: 'Payment past due', detail: 'Update billing to keep automation running.' }
  if (data.status === 'expired') return { title: 'Trial ended', detail: 'Subscribe to reactivate customer order automation.' }
  return { title: 'Subscription cancelled', detail: 'Subscribe again to reactivate customer order automation.' }
}

const cardBody: React.CSSProperties = { padding: '1.25rem 1.5rem' }

export default function BillingPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [checkoutError, setCheckoutError] = useState('')

  const billing = useQuery<SubscriptionState>({
    queryKey: ['billing', merchantId],
    enabled: !!merchantId,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}/subscription`)
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json() as SubscriptionState
      if (data.email) setEmail(data.email)
      return data
    },
  })

  const copy = statusCopy(billing.data)
  const needsEmail = billing.data?.needsEmail
  const canSubscribe = !!billing.data && !needsEmail && billing.data.status !== 'active'

  async function saveEmail() {
    setSavingEmail(true); setEmailError('')
    const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}/billing-email`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    setSavingEmail(false)
    if (!res.ok) { setEmailError(await res.text()); return }
    await queryClient.invalidateQueries({ queryKey: ['billing', merchantId] })
  }

  async function startCheckout() {
    setCheckoutLoading(true); setCheckoutError('')
    const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}/subscription/checkout`, { method: 'POST' })
    setCheckoutLoading(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      setCheckoutError(body?.error ?? 'Unable to start checkout.')
      return
    }
    const body = await res.json() as { paymentLink?: string }
    if (!body.paymentLink) { setCheckoutError('Unable to start checkout.'); return }
    window.location.href = body.paymentLink
  }

  return (
    <div className="pb-tab stagger">
      <TopBar title="Billing" sub="Plan & subscription" />
      <div className="pad">
        <div style={{ display: 'grid', gap: '1rem' }}>

          {/* Status card */}
          <div className="card fade-up" style={cardBody}>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'var(--fm)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {billing.data?.status?.replace('_', ' ') ?? 'Status'}
            </div>
            <div style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: '1.35rem', color: 'var(--ink)', marginBottom: 6 }}>
              {copy.title}
            </div>
            <div style={{ color: 'var(--muted)', lineHeight: 1.6, fontSize: '0.9rem' }}>{copy.detail}</div>
            {billing.data?.status === 'trialing' && (
              <div style={{ height: 8, borderRadius: 999, background: 'var(--line)', marginTop: '1rem', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, (billing.data.daysRemaining / 7) * 100))}%`,
                  height: '100%',
                  background: 'var(--mint)',
                }} />
              </div>
            )}
          </div>

          {/* Email card */}
          {needsEmail && (
            <div className="card fade-up" style={cardBody}>
              <div style={{ fontFamily: 'var(--fd)', fontWeight: 700, fontSize: '1rem', marginBottom: 8, color: 'var(--ink)' }}>Billing email</div>
              <div style={{ color: 'var(--muted)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                Add an email for Paystack receipts and subscription records.
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  className="form-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@business.com"
                />
                <button className="btn btn-md btn-primary" onClick={saveEmail} disabled={savingEmail} style={{ whiteSpace: 'nowrap' }}>
                  {savingEmail ? 'Saving…' : 'Save'}
                </button>
              </div>
              {emailError && <div style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginTop: 8 }}>{emailError}</div>}
            </div>
          )}

          {/* Plan card */}
          <div className="card fade-up" style={cardBody}>
            <div style={{ fontFamily: 'var(--fd)', fontWeight: 700, fontSize: '1rem', marginBottom: 8, color: 'var(--ink)' }}>Plan</div>
            <div style={{ color: 'var(--ink)', fontWeight: 700, marginBottom: 4 }}>
              {(billing.data?.plan ?? 'starter').replace(/\b\w/g, c => c.toUpperCase())}
            </div>
            {checkoutError && <div style={{ color: 'var(--danger)', fontSize: '0.875rem', marginBottom: 10 }}>{checkoutError}</div>}
            <button className="btn btn-md btn-primary" disabled={!canSubscribe || checkoutLoading} onClick={startCheckout}>
              {checkoutLoading ? 'Starting checkout...' : 'Subscribe now'}
            </button>
          </div>

          {/* Billing history */}
          <div className="table-container fade-up">
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontFamily: 'var(--fd)', fontWeight: 700, fontSize: '1rem', color: 'var(--ink)' }}>Billing history</div>
            </div>
            {(billing.data?.events ?? []).length === 0 ? (
              <div style={{ padding: '1.25rem', color: 'var(--muted)', fontSize: '0.875rem' }}>No billing events yet.</div>
            ) : (
              (billing.data?.events ?? []).map(event => (
                <div key={event.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{event.type.replace(/_/g, ' ')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: '0.8125rem', fontFamily: 'var(--fm)' }}>
                    {new Date(event.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
