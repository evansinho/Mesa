import { useState } from 'react'
import { Icon } from '../../components/ui/Icon'
import { Btn } from '../../components/ui/Btn'
import { Lockup } from '../../components/ui/Lockup'

const SLIDES = [
  {
    icon: 'message-square-text',
    k: 'Inside WhatsApp',
    t: 'Your orders find you.',
    b: 'Mesa reads your WhatsApp chats and catches every order the moment a customer agrees, even mid-negotiation.',
    art: 'chat',
  },
  {
    icon: 'scan-line',
    k: 'Payments, confirmed',
    t: 'No more fake alerts.',
    b: 'Send a transfer screenshot and Mesa reads it in seconds, then marks the order paid. Stop eyeballing receipts.',
    art: 'pay',
  },
  {
    icon: 'trending-up',
    k: 'Built-in credit',
    t: 'Stock more. Sell more.',
    b: 'Every order builds your record. After 30 days, unlock working capital that repays itself from your sales.',
    art: 'lend',
  },
]

function Art({ kind }: { kind: string }) {
  if (kind === 'chat') {
    return (
      <div className="glass" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ alignSelf: 'flex-start', background: 'rgba(255,255,255,.12)', color: '#fff', padding: '10px 13px', borderRadius: 14, borderTopLeftRadius: 4, fontSize: 14, maxWidth: '80%' }}>
          Okay deal, send your account
        </div>
        <div style={{ alignSelf: 'stretch', background: 'var(--deep)', border: '1px solid rgba(43,212,138,.5)', borderRadius: 12, padding: '13px 14px', marginTop: 4 }}>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--mint)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="zap" size={13} strokeWidth={2.4} /> Order detected
          </div>
          <div style={{ color: '#fff', fontSize: 15, margin: '9px 0 11px' }}>10 bags of rice · <b style={{ color: 'var(--mint)' }}>₦42,000</b></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ flex: 1, textAlign: 'center', background: 'var(--mint)', color: 'var(--on-accent)', fontFamily: 'var(--fm)', fontSize: 13, fontWeight: 600, padding: 10, borderRadius: 9 }}>YES</span>
            <span style={{ flex: 1, textAlign: 'center', border: '1px solid rgba(255,255,255,.25)', color: 'rgba(255,255,255,.8)', fontFamily: 'var(--fm)', fontSize: 13, padding: 10, borderRadius: 9 }}>Edit</span>
          </div>
        </div>
      </div>
    )
  }
  if (kind === 'pay') {
    return (
      <div className="glass" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: '#fff', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ background: '#5b2d8e', color: '#fff', padding: '9px 13px', fontSize: 13, fontWeight: 600 }}>Transfer successful</div>
          <div style={{ padding: '12px 14px' }}>
            <div style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 26, color: 'var(--ink)' }}>₦42,000</div>
            <div style={{ fontFamily: 'var(--fm)', fontSize: 11, color: '#6b6458', marginTop: 4 }}>to MESA STORES</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--mint)', color: 'var(--on-accent)', borderRadius: 12, padding: '12px 14px' }}>
          <Icon name="check-check" size={20} strokeWidth={2.4} />
          <span style={{ fontFamily: 'var(--fd)', fontWeight: 700, fontSize: 15 }}>Marked paid · ₦42,000</span>
        </div>
      </div>
    )
  }
  return (
    <div className="glass" style={{ padding: 20 }}>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--mint)' }}>Available to you</div>
      <div style={{ fontFamily: 'var(--fd)', fontWeight: 800, fontSize: 40, color: '#fff', letterSpacing: '-.03em', marginTop: 8 }}>₦450,000</div>
      <div style={{ marginTop: 16 }} className="meter on-dark"><div className="fill" style={{ width: '64%' }} /></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--muted-inv)' }}>
        <span>Repays from sales</span><span style={{ color: 'var(--mint)' }}>2.5%/mo</span>
      </div>
    </div>
  )
}

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0)
  const last = i === SLIDES.length - 1
  const s = SLIDES[i]

  return (
    <div className="screen dark" style={{ minHeight: '100dvh' }}>
      <div className="screen-scroll" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, paddingBottom: 10 }}>
          <Lockup markSize={30} wordSize={22} light />
          {!last && (
            <button className="btn btn-sm" style={{ color: 'var(--mint)' }} onClick={onDone}>Skip</button>
          )}
        </div>
        <div className="pad" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingBottom: 20 }}>
          <div key={i} className="fade-up" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ alignSelf: 'flex-start', width: 52, height: 52, borderRadius: 15, background: 'rgba(43,212,138,.16)', border: '1px solid rgba(43,212,138,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mint)', marginBottom: 22 }}>
              <Icon name={s.icon} size={26} strokeWidth={2} />
            </div>
            <div className="kicker">{s.k}</div>
            <h1 className="h-display" style={{ color: '#fff', fontSize: 40, marginTop: 12 }}>{s.t}</h1>
            <p style={{ color: 'var(--muted-inv)', fontSize: 16.5, lineHeight: 1.5, marginTop: 14, maxWidth: '30ch' }}>{s.b}</p>
            <div style={{ marginTop: 30 }}><Art kind={s.art} /></div>
          </div>
        </div>
      </div>
      <div style={{ padding: '8px 20px 30px' }}>
        <div className="dots on-dark" style={{ marginBottom: 22 }}>
          {SLIDES.map((_, k) => <span key={k} className={`d${k === i ? ' on' : ''}`} />)}
        </div>
        <Btn kind="mint" block iconRight={last ? 'arrow-right' : undefined} onClick={() => last ? onDone() : setI(i + 1)}>
          {last ? 'Get started' : 'Next'}
        </Btn>
      </div>
    </div>
  )
}
