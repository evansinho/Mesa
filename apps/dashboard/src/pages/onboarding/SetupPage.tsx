import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle, Check, ChevronDown, ChevronUp, ChevronLeft } from 'lucide-react'
import { AuthHeader } from '../../components/ui/AuthHeader'
import { Btn } from '../../components/ui/Btn'
import { ConnectWAScreen } from '../auth/ConnectWAScreen'
import { getSession } from '../../lib/auth'
import { apiFetch } from '../../lib/api'

type Step = 'business' | 'products' | 'payment' | 'connect'

const STEP_ORDER: Step[] = ['business', 'products', 'payment', 'connect']

const CATEGORIES = [
  'Fashion & textiles', 'Food & groceries', 'Electronics & gadgets', 'Beauty & cosmetics',
  'Building materials', 'Auto parts', 'Pharmacy & health', 'Other',
]


function parseProductLines(raw: string): { name: string; price: number }[] {
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/—|-|:/)
    if (parts.length < 2) return null
    const name = parts[0].trim()
    const price = parseFloat(parts.slice(1).join('').replace(/[₦,\s]/g, '').replace(/[^\d.]/g, ''))
    if (!name || isNaN(price)) return null
    return { name, price }
  }).filter((p): p is { name: string; price: number } => p !== null)
}

// ─── Step 1: Business ─────────────────────────────────────────────────────────

function BusinessStep({ merchantId, onDone }: { merchantId: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [cat, setCat] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const ok = name.trim().length > 1 && cat

  const handleContinue = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), businessType: cat }),
      })
      if (!res.ok) throw new Error(await res.text())
      onDone()
    } catch (e) {
      setError((e as Error).message || 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <AuthHeader />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <div className="kicker">Set up your store</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>Tell us about your business.</h1>
        <div style={{ marginTop: 26 }}>
          <div className="field">
            <label>Business name</label>
            <input className="input" placeholder="e.g. Temi Stores" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>What do you sell?</label>
            <button
              className="input"
              style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: cat ? 'var(--ink)' : 'var(--subtle)' }}
              onClick={() => setOpen(o => !o)}
            >
              {cat || 'Choose a category'}
              {open ? <ChevronUp size={18} strokeWidth={2} color="var(--muted)" /> : <ChevronDown size={18} strokeWidth={2} color="var(--muted)" />}
            </button>
            {open && (
              <div className="card fade-up" style={{ marginTop: 8, overflow: 'hidden', padding: 0 }}>
                {CATEGORIES.map(c => (
                  <button key={c} onClick={() => { setCat(c); setOpen(false) }}
                    style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--line)', fontSize: 15, color: 'var(--ink)', textAlign: 'left', background: 'none' }}>
                    {c}
                    {cat === c && <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          {error && (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
      <div className="footbar">
        <Btn kind="primary" block disabled={!ok} loading={loading} iconRight="arrow-right" onClick={handleContinue}>
          Continue
        </Btn>
      </div>
    </div>
  )
}

// ─── Step 2: Products ─────────────────────────────────────────────────────────

function ProductsStep({ merchantId, onBack, onDone }: { merchantId: string; onBack: () => void; onDone: () => void }) {
  const [bulk, setBulk] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const preview = parseProductLines(bulk)

  const handleAdd = async () => {
    if (preview.length === 0) { setError('No valid products found. Format: Name — ₦Price'); return }
    setLoading(true)
    setError('')
    try {
      for (const p of preview) {
        const res = await apiFetch(`/merchants/${merchantId}/products`, {
          method: 'POST',
          body: JSON.stringify({ name: p.name, price: p.price }),
        })
        if (!res.ok) { const t = await res.text(); throw new Error(`"${p.name}": ${t}`) }
      }
      onDone()
    } catch (e) {
      setError((e as Error).message || 'Failed to add products')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <AuthHeader />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--muted)', fontSize: 14, fontWeight: 500, marginBottom: 16, padding: 0 }}>
          <ChevronLeft size={16} strokeWidth={2} /> Back
        </button>
        <div className="kicker">Your catalogue</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>Add your products.</h1>
        <p className="muted" style={{ fontSize: 15, lineHeight: 1.5, marginTop: 10 }}>
          One per line: <span style={{ fontFamily: 'var(--fm)', fontSize: 13 }}>Name — ₦Price</span>. You can always add more later.
        </p>
        <div style={{ marginTop: 22 }}>
          <div className="field">
            <label>Products</label>
            <textarea
              className="input"
              value={bulk}
              onChange={e => setBulk(e.target.value)}
              placeholder={'Garri — ₦800\nRice — ₦2500\nPalm oil — ₦1200'}
              rows={6}
              style={{ resize: 'vertical', fontFamily: 'var(--fm)', fontSize: 13.5 }}
            />
          </div>
          {preview.length > 0 && (
            <div className="card fade-up" style={{ padding: '12px 16px', marginTop: 0 }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>{preview.length} product{preview.length !== 1 ? 's' : ''} detected</p>
              {preview.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink)', padding: '3px 0' }}>
                  <span>{p.name}</span>
                  <span style={{ color: 'var(--muted)' }}>₦{p.price.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
      <div className="footbar">
        <Btn kind="primary" block disabled={preview.length === 0} loading={loading} iconRight="arrow-right" onClick={handleAdd}>
          Add products
        </Btn>
        <button onClick={onDone} style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 14, fontSize: 14, color: 'var(--muted)', padding: 0 }}>
          Skip for now
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Payment ──────────────────────────────────────────────────────────

function PaymentStep({ merchantId, onBack, onDone }: { merchantId: string; onBack: () => void; onDone: () => void }) {
  const [banks, setBanks] = useState<Array<{ name: string; code: string }>>([])
  const [bank, setBank] = useState<{ name: string; code: string } | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  const [bankSearch, setBankSearch] = useState('')
  const [accNum, setAccNum] = useState('')
  const [accName, setAccName] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const ok = bank && accNum.length === 10 && accName.trim().length > 1

  useEffect(() => {
    let cancelled = false
    apiFetch('/banks')
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((body: { banks: Array<{ name: string; code: string }> }) => {
        if (!cancelled) setBanks(body.banks)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  // Auto-verify the account name from Paystack once we have bank + 10 digits.
  useEffect(() => {
    if (!bank || accNum.length !== 10) {
      setResolved(false)
      setResolveFailed(false)
      return
    }
    let cancelled = false
    setResolving(true)
    setResolveFailed(false)
    apiFetch('/banks/resolve', {
      method: 'POST',
      body: JSON.stringify({ accountNumber: accNum, bankCode: bank.code }),
    })
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then((body: { accountName: string }) => {
        if (cancelled) return
        setAccName(body.accountName)
        setResolved(true)
      })
      .catch(() => {
        if (cancelled) return
        setResolved(false)
        setResolveFailed(true)
      })
      .finally(() => { if (!cancelled) setResolving(false) })
    return () => { cancelled = true }
  }, [bank, accNum])

  const handleSave = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/merchants/${merchantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: {
            bankAccount: {
              bankName: bank!.name,
              bankCode: bank!.code,
              accountNumber: accNum,
              accountName: accName.trim(),
              verified: resolved,
            },
          },
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      onDone()
    } catch (e) {
      setError((e as Error).message || 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  const filteredBanks = bankSearch.trim()
    ? banks.filter(b => b.name.toLowerCase().includes(bankSearch.trim().toLowerCase()))
    : banks

  return (
    <div className="screen">
      <AuthHeader />
      <div className="screen-scroll pad" style={{ paddingTop: 8 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--muted)', fontSize: 14, fontWeight: 500, marginBottom: 16, padding: 0 }}>
          <ChevronLeft size={16} strokeWidth={2} /> Back
        </button>
        <div className="kicker">Get paid</div>
        <h1 className="h-display" style={{ fontSize: 34, marginTop: 12 }}>Where should customers pay?</h1>
        <p className="muted" style={{ fontSize: 15, lineHeight: 1.5, marginTop: 10 }}>
          Mesa will share these details with customers when an order is confirmed.
        </p>
        <div style={{ marginTop: 22 }}>
          <div className="field">
            <label>Bank</label>
            <button
              className="input"
              style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: bank ? 'var(--ink)' : 'var(--subtle)' }}
              onClick={() => setBankOpen(o => !o)}
            >
              {bank?.name || (banks.length ? 'Select your bank' : 'Loading banks…')}
              {bankOpen ? <ChevronUp size={18} strokeWidth={2} color="var(--muted)" /> : <ChevronDown size={18} strokeWidth={2} color="var(--muted)" />}
            </button>
            {bankOpen && (
              <div className="card fade-up" style={{ marginTop: 8, overflow: 'hidden', padding: 0 }}>
                <input
                  className="input"
                  autoFocus
                  placeholder="Search banks…"
                  value={bankSearch}
                  onChange={e => setBankSearch(e.target.value)}
                  style={{ border: 'none', borderBottom: '1px solid var(--line)', borderRadius: 0 }}
                />
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {filteredBanks.map(b => (
                    <button key={b.code} onClick={() => { setBank(b); setBankOpen(false); setBankSearch('') }}
                      style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--line)', fontSize: 15, color: 'var(--ink)', textAlign: 'left', background: 'none' }}>
                      {b.name}
                      {bank?.code === b.code && <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />}
                    </button>
                  ))}
                  {filteredBanks.length === 0 && (
                    <p className="muted" style={{ padding: '13px 16px', fontSize: 14 }}>No banks match "{bankSearch}"</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="field">
            <label>Account number</label>
            <input
              className="input"
              inputMode="numeric"
              placeholder="10-digit account number"
              value={accNum}
              maxLength={10}
              onChange={e => { setAccNum(e.target.value.replace(/\D/g, '').slice(0, 10)); setAccName('') }}
            />
          </div>
          <div className="field">
            <label>Account name</label>
            {resolved ? (
              <div className="input" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink)' }}>
                <Check size={16} strokeWidth={2.4} color="var(--mint-deep)" />
                <span>{accName}</span>
              </div>
            ) : (
              <input
                className="input"
                placeholder={resolving ? 'Verifying account…' : 'Name on the account'}
                value={accName}
                disabled={resolving}
                onChange={e => setAccName(e.target.value)}
              />
            )}
            {resolving && <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Checking with the bank…</p>}
            {resolved && <p style={{ fontSize: 12.5, marginTop: 6, color: 'var(--mint-deep)' }}>Verified with the bank.</p>}
            {resolveFailed && (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                Couldn't verify automatically — check the number, or type the account name yourself.
              </p>
            )}
          </div>
          {error && (
            <div className="alert-error">
              <AlertCircle size={16} strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
      <div className="footbar">
        <Btn kind="primary" block disabled={!ok} loading={loading} iconRight="arrow-right" onClick={handleSave}>
          Save & continue
        </Btn>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OnboardingSetupPage() {
  const navigate = useNavigate()
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [step, setStep] = useState<Step>('business')

  const stepIndex = STEP_ORDER.indexOf(step)

  const handleConnectDone = async () => {
    try {
      await apiFetch(`/merchants/${merchantId}/onboarding/complete`, { method: 'POST' })
    } catch {}
    void navigate({ to: '/' })
  }

  return (
    <div className="app app--auth">
      {/* Progress bar */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 100,
        background: 'var(--line)',
      }}>
        <div style={{
          height: '100%',
          width: `${((stepIndex + 1) / STEP_ORDER.length) * 100}%`,
          background: 'var(--mint-deep)',
          transition: 'width 0.4s var(--ease)',
        }} />
      </div>

      {step === 'business' && (
        <BusinessStep merchantId={merchantId} onDone={() => setStep('products')} />
      )}
      {step === 'products' && (
        <ProductsStep
          merchantId={merchantId}
          onBack={() => setStep('business')}
          onDone={() => setStep('payment')}
        />
      )}
      {step === 'payment' && (
        <PaymentStep
          merchantId={merchantId}
          onBack={() => setStep('products')}
          onDone={() => setStep('connect')}
        />
      )}
      {step === 'connect' && session && (
        <ConnectWAScreen
          session={session}
          onBack={() => setStep('payment')}
          onDone={handleConnectDone}
        />
      )}
    </div>
  )
}
