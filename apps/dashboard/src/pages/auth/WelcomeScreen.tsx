import { Icon } from '../../components/ui/Icon'
import { Btn } from '../../components/ui/Btn'
import { Lockup } from '../../components/ui/Lockup'

const TICKS = [
  'Catch every WhatsApp order automatically',
  'Confirm payments from a screenshot',
  'Unlock working capital as you sell',
]

type Props = { onSignup: () => void; onSignin: () => void }

export function WelcomeScreen({ onSignup, onSignin }: Props) {
  return (
    <div className="screen dark" style={{ background: 'var(--deep)', minHeight: '100dvh' }}>
      <div className="screen-scroll pad" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ paddingTop: 14 }}><Lockup markSize={34} wordSize={28} light /></div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingBottom: 8 }}>
          <div className="kicker" style={{ color: 'var(--mint)' }}>Mesa for merchants</div>
          <h1 className="h-display" style={{ color: '#fff', fontSize: 42, marginTop: 14, maxWidth: '14ch' }}>
            Run your shop from one chat.
          </h1>
          <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {TICKS.map(t => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(43,212,138,.16)', border: '1px solid rgba(43,212,138,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mint)', flexShrink: 0 }}>
                  <Icon name="check" size={14} strokeWidth={3} />
                </span>
                <span style={{ color: 'var(--muted-inv)', fontSize: 15.5 }}>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ padding: '10px 20px 30px' }}>
        <Btn kind="mint" block iconRight="arrow-right" onClick={onSignup}>Create account</Btn>
        <button
          className="btn btn-ghost btn-lg btn-block"
          style={{ marginTop: 11, borderColor: 'rgba(255,255,255,.26)', color: '#fff' }}
          onClick={onSignin}
        >
          I already have an account
        </button>
        <p className="tcenter" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 18, color: 'var(--subtle-inv)' }}>
          By continuing you agree to Mesa's Terms &amp; Privacy Policy.
        </p>
      </div>
    </div>
  )
}
