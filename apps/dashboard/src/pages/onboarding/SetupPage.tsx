import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { getSession, clearSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'

type Step = 'business' | 'products' | 'payment' | 'finish'

interface CompletedSteps {
  business: boolean
  products: boolean
  payment: boolean
}

// ─── Business Step ───────────────────────────────────────────────────────────

const BUSINESS_CATEGORIES = [
  'Retail',
  'Food & Beverage',
  'Fashion',
  'Electronics',
  'Services',
  'Agriculture',
  'Other',
]

interface BusinessStepProps {
  merchantId: string
  onDone: () => void
}

function BusinessStep({ merchantId, onDone }: BusinessStepProps) {
  const [businessName, setBusinessName] = useState('')
  const [businessCategory, setBusinessCategory] = useState('')
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!businessName.trim()) {
      setError('Business name is required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: businessName.trim(),
          businessType: businessCategory || undefined,
          config: location ? { location: location.trim() } : undefined,
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        setError(text || 'Failed to save. Please try again.')
        return
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <label style={labelStyle}>Business name <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input
          className="input"
          type="text"
          value={businessName}
          onChange={e => setBusinessName(e.target.value)}
          placeholder="e.g. Chidi Foods"
          required
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Business category</label>
        <select
          className="input"
          value={businessCategory}
          onChange={e => setBusinessCategory(e.target.value)}
          style={inputStyle}
        >
          <option value="">Select a category</option>
          {BUSINESS_CATEGORIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Location <span style={{ color: 'var(--smoke)', fontWeight: 400 }}>(optional)</span></label>
        <input
          className="input"
          type="text"
          value={location}
          onChange={e => setLocation(e.target.value)}
          placeholder="e.g. Lagos, Nigeria"
          style={inputStyle}
        />
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
      <button type="submit" className="btn-primary" disabled={saving} style={{ justifyContent: 'center' }}>
        {saving ? 'Saving...' : 'Continue'}
      </button>
    </form>
  )
}

// ─── Products Step ────────────────────────────────────────────────────────────

function parseProductLines(raw: string): { name: string; price: number }[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Split on em dash, hyphen, or colon
      const parts = line.split(/—|-|:/)
      if (parts.length < 2) return null
      const name = parts[0].trim()
      const rawPrice = parts.slice(1).join('').replace(/[₦,\s]/g, '').replace(/[^\d.]/g, '')
      const price = parseFloat(rawPrice)
      if (!name || isNaN(price)) return null
      return { name, price }
    })
    .filter((p): p is { name: string; price: number } => p !== null)
}

interface ProductsStepProps {
  merchantId: string
  onDone: () => void
}

function ProductsStep({ merchantId, onDone }: ProductsStepProps) {
  const [bulk, setBulk] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ name: string; price: number }[]>([])

  function handleBulkChange(val: string) {
    setBulk(val)
    setPreview(parseProductLines(val))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parsed = parseProductLines(bulk)
    if (parsed.length === 0) {
      setError('No valid products found. Format each line as: Name — ₦Price')
      return
    }
    setSaving(true)
    setError('')
    try {
      for (const product of parsed) {
        const res = await apiFetch(`/merchants/${merchantId}/products`, {
          method: 'POST',
          body: JSON.stringify({ name: product.name, price: product.price }),
        })
        if (!res.ok) {
          const text = await res.text()
          setError(`Failed to add "${product.name}": ${text}`)
          return
        }
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <label style={labelStyle}>Add products</label>
        <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', marginBottom: '0.5rem' }}>
          One product per line: Name — ₦Price
        </p>
        <textarea
          className="input"
          value={bulk}
          onChange={e => handleBulkChange(e.target.value)}
          placeholder={'Garri — ₦800\nRice — ₦2500\nPalm oil — ₦1200'}
          rows={6}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.875rem' }}
        />
      </div>
      {preview.length > 0 && (
        <div style={{ background: 'var(--surface-2, rgba(0,0,0,0.03))', borderRadius: 8, padding: '0.75rem', fontSize: '0.8125rem' }}>
          <p style={{ fontWeight: 600, marginBottom: '0.375rem', color: 'var(--ink)' }}>Preview ({preview.length} products)</p>
          {preview.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--smoke)', padding: '2px 0' }}>
              <span>{p.name}</span>
              <span>₦{p.price.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button type="submit" className="btn-primary" disabled={saving} style={{ justifyContent: 'center' }}>
          {saving ? 'Adding...' : 'Add Products'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={onDone}
          style={{ fontSize: '0.875rem' }}
        >
          Skip for now
        </button>
      </div>
    </form>
  )
}

// ─── Payment Step ─────────────────────────────────────────────────────────────

interface PaymentStepProps {
  merchantId: string
  onDone: () => void
}

function PaymentStep({ merchantId, onDone }: PaymentStepProps) {
  const [bankName, setBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [paymentInstructions, setPaymentInstructions] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!bankName.trim()) { setError('Bank name is required.'); return }
    if (accountNumber.length !== 10) { setError('Account number must be exactly 10 digits.'); return }
    if (!accountName.trim()) { setError('Account name is required.'); return }
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: {
            bankAccount: {
              bankName: bankName.trim(),
              accountNumber: accountNumber.trim(),
              accountName: accountName.trim(),
            },
            paymentInstructions: paymentInstructions.trim() || undefined,
          },
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        setError(text || 'Failed to save. Please try again.')
        return
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '1rem' }}>
      <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)', lineHeight: 1.5 }}>
        Enter your bank details. Customers will send payment to this account.
      </p>
      <div>
        <label style={labelStyle}>Bank name</label>
        <input
          className="input"
          type="text"
          value={bankName}
          onChange={e => setBankName(e.target.value)}
          placeholder="e.g. First Bank"
          style={inputStyle}
          required
        />
      </div>
      <div>
        <label style={labelStyle}>Account number</label>
        <input
          className="input"
          type="text"
          value={accountNumber}
          onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder="10-digit account number"
          maxLength={10}
          style={inputStyle}
          required
        />
      </div>
      <div>
        <label style={labelStyle}>Account name</label>
        <input
          className="input"
          type="text"
          value={accountName}
          onChange={e => setAccountName(e.target.value)}
          placeholder="Name on the account"
          style={inputStyle}
          required
        />
      </div>
      <div>
        <label style={labelStyle}>Payment instructions <span style={{ color: 'var(--smoke)', fontWeight: 400 }}>(optional)</span></label>
        <textarea
          className="input"
          value={paymentInstructions}
          onChange={e => setPaymentInstructions(e.target.value)}
          placeholder="e.g. Send payment to the account above and send a screenshot to confirm."
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
      <button type="submit" className="btn-primary" disabled={saving} style={{ justifyContent: 'center' }}>
        {saving ? 'Saving...' : 'Save & Continue'}
      </button>
    </form>
  )
}

// ─── Finish Step ──────────────────────────────────────────────────────────────

interface FinishStepProps {
  merchantId: string
  completed: CompletedSteps
}

function FinishStep({ merchantId, completed }: FinishStepProps) {
  const navigate = useNavigate()
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState('')

  async function handleLaunch() {
    setLaunching(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}/onboarding/complete`, {
        method: 'POST',
      })
      if (!res.ok) {
        const text = await res.text()
        setError(text || 'Failed to complete setup. Please try again.')
        return
      }
      void navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    } finally {
      setLaunching(false)
    }
  }

  const checks: { label: string; done: boolean }[] = [
    { label: 'WhatsApp connected', done: true },
    { label: 'Business info', done: completed.business },
    { label: 'Products added', done: completed.products },
    { label: 'Payment details', done: completed.payment },
  ]

  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {checks.map(c => (
          <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.9375rem' }}>
            <span style={{ color: c.done ? '#25D366' : 'var(--smoke)', flexShrink: 0 }}>
              {c.done ? (
                <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" style={{ width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }}>
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
            </span>
            <span style={{ color: c.done ? 'var(--ink)' : 'var(--smoke)' }}>{c.label}</span>
          </div>
        ))}
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
      <button
        className="btn-primary"
        onClick={handleLaunch}
        disabled={launching}
        style={{ justifyContent: 'center' }}
      >
        {launching ? 'Launching...' : 'Launch Mesa'}
      </button>
    </div>
  )
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontWeight: 600,
  fontSize: '0.875rem',
  color: 'var(--ink)',
  marginBottom: '0.375rem',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
}

// ─── Step config ──────────────────────────────────────────────────────────────

const STEPS: { key: Step; label: string; number: number }[] = [
  { key: 'business', label: 'Business', number: 1 },
  { key: 'products', label: 'Products', number: 2 },
  { key: 'payment', label: 'Payment', number: 3 },
  { key: 'finish', label: 'Finish', number: 4 },
]

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OnboardingSetupPage() {
  const navigate = useNavigate()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [step, setStep] = useState<Step>('business')

  function handleLogout() {
    clearSession()
    void navigate({ to: '/login' })
  }
  const [completed, setCompleted] = useState<CompletedSteps>({
    business: false,
    products: false,
    payment: false,
  })

  function advance(completedStep: keyof CompletedSteps | null, next: Step) {
    if (completedStep) {
      setCompleted(prev => ({ ...prev, [completedStep]: true }))
    }
    setStep(next)
  }

  const currentStepIndex = STEPS.findIndex(s => s.key === step)

  const stepTitles: Record<Step, string> = {
    business: 'Tell us about your business',
    products: 'Add your products',
    payment: 'Set up payment details',
    finish: "You're almost ready",
  }
  const stepSubtitles: Record<Step, string> = {
    business: 'This helps Mesa personalise your orders and customer messages.',
    products: 'Mesa will use these for order matching. You can always add more later.',
    payment: 'Customers will be directed to pay to this account.',
    finish: "Here's a summary of what you set up.",
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: '2rem 1rem', background: 'var(--bg)' }}>
      {/* Header row: logo + logout */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 480, marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '1.25rem', color: 'var(--ink)' }}>
          <img src="/mark-tile.svg" width="32" height="32" alt="" />
          <span style={{ fontFamily: "'Newsreader', Georgia, serif", fontWeight: 600 }}>Mesa</span>
        </div>
        <button
          onClick={handleLogout}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.875rem', color: 'var(--smoke)', padding: '4px 8px', borderRadius: 6 }}
        >
          Log out
        </button>
      </div>

      {/* Card */}
      <div className="card" style={{ width: '100%', maxWidth: 480, padding: '2rem' }}>
        {/* Progress dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.75rem' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.75rem', fontWeight: 700,
                background: i < currentStepIndex
                  ? 'var(--forest)'
                  : i === currentStepIndex
                    ? 'var(--forest)'
                    : 'var(--surface-2, rgba(0,0,0,0.06))',
                color: i <= currentStepIndex ? '#fff' : 'var(--smoke)',
                transition: 'background 0.2s',
              }}>
                {i < currentStepIndex ? (
                  <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, fill: 'none', stroke: '#fff', strokeWidth: 3 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : s.number}
              </div>
              {i < STEPS.length - 1 && (
                <div style={{
                  width: 32, height: 2,
                  background: i < currentStepIndex ? 'var(--forest)' : 'var(--surface-2, rgba(0,0,0,0.08))',
                  borderRadius: 1,
                  transition: 'background 0.2s',
                }} />
              )}
            </div>
          ))}
        </div>

        {/* Step header */}
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--smoke)', marginBottom: '0.375rem' }}>
            Step {currentStepIndex + 1} of {STEPS.length}
          </p>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--ink)', margin: 0, marginBottom: '0.375rem' }}>
            {stepTitles[step]}
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--smoke)', lineHeight: 1.5, margin: 0 }}>
            {stepSubtitles[step]}
          </p>
        </div>

        {/* Step content */}
        {step === 'business' && (
          <BusinessStep
            merchantId={merchantId}
            onDone={() => advance('business', 'products')}
          />
        )}
        {step === 'products' && (
          <ProductsStep
            merchantId={merchantId}
            onDone={() => advance('products', 'payment')}
          />
        )}
        {step === 'payment' && (
          <PaymentStep
            merchantId={merchantId}
            onDone={() => advance('payment', 'finish')}
          />
        )}
        {step === 'finish' && (
          <FinishStep merchantId={merchantId} completed={completed} />
        )}
      </div>
    </div>
  )
}
