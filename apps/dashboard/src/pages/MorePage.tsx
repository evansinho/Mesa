import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
import { Badge } from '../components/ui/Badge'
import { useOverlay } from '../context/OverlayContext'
import { useToast } from '../context/ToastContext'
import { apiFetch } from '../lib/api'
import { getSession, clearSession } from '../lib/auth'

type Merchant = { name: string; businessType?: string | null; phone?: string }

function initials(name: string) {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2) || 'M'
}

const GROUPS = [
  {
    title: 'Business',
    items: [
      { icon: '🏪', label: 'Store profile',       hint: '',            route: '/settings' },
      { icon: '📦', label: 'Inventory',            hint: '',            route: '/inventory' },
      { icon: '💬', label: 'WhatsApp connection',  hint: 'Connected',   route: '/settings' },
      { icon: '👥', label: 'Customers',            hint: '',            route: '/customers' },
    ],
  },
  {
    title: 'Money',
    items: [
      { icon: '↗', label: 'Mesa Lend',            hint: '₦450k available', route: 'lend' },
      { icon: '🏦', label: 'Payout account',       hint: '',            route: '/settings' },
      { icon: '🧾', label: 'Plan & billing',        hint: '',            route: '/billing' },
    ],
  },
  {
    title: 'Support',
    items: [
      { icon: '❓', label: 'Help centre',           hint: '',            route: 'toast' },
      { icon: '🔒', label: 'Security & privacy',   hint: '',            route: 'toast' },
      { icon: '⚙️', label: 'Settings',              hint: '',            route: '/settings' },
    ],
  },
]

export default function MorePage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const navigate = useNavigate()
  const { openOverlay } = useOverlay()
  const { toast } = useToast()

  const merchant = useQuery<{ merchant: Merchant }>({
    queryKey: ['merchant', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${merchantId}`)
      if (!res.ok) return { merchant: { name: '' } }
      return res.json()
    },
  })

  const m = merchant.data?.merchant
  const name = m?.name ?? 'My Store'
  const cat = m?.businessType ?? ''
  const phone = m?.phone ?? ''

  const handleRow = (route: string) => {
    if (route === 'lend') { openOverlay({ type: 'lend' }); return }
    if (route === 'toast') { toast('Coming soon'); return }
    navigate({ to: route as '/' })
  }

  const handleSignOut = () => {
    clearSession()
    navigate({ to: '/login' })
  }

  return (
    <div className="pb-tab stagger">
      <TopBar title="More" />
      <div className="pad">
        {/* Business header */}
        <div className="card card-lg card-pad fade-up flex aic gap12">
          <div className="avatar" style={{ width: 54, height: 54, fontSize: 22, borderRadius: 16 }}>
            {initials(name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 17 }}>{name}</div>
            <div className="muted" style={{ fontSize: 13 }}>{[cat, phone].filter(Boolean).join(' · ')}</div>
          </div>
          <Badge tone="mint" dot>Verified</Badge>
        </div>

        {GROUPS.map(g => (
          <div key={g.title}>
            <div className="sec-head"><span className="st" style={{ fontSize: 15 }}>{g.title}</span></div>
            <div className="card card-pad fade-up">
              {g.items.map(item => (
                <button key={item.label} className="row" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => handleRow(item.route)}>
                  <div className="r-ic" style={{ fontSize: 18, background: 'var(--paper-2)', border: '1px solid var(--line)' }}>
                    {item.icon}
                  </div>
                  <div className="r-main">
                    <div className="r-t">{item.label}</div>
                  </div>
                  {item.hint && <span className="muted" style={{ fontSize: 12.5, marginRight: 6 }}>{item.hint}</span>}
                  <ChevronRight size={18} strokeWidth={2} color="var(--subtle)" />
                </button>
              ))}
            </div>
          </div>
        ))}

        <button
          className="btn btn-ghost btn-lg btn-block"
          style={{ marginTop: 22, color: 'var(--danger)', borderColor: 'rgba(192,73,47,.3)' }}
          onClick={handleSignOut}
        >
          Sign out
        </button>
        <p className="tcenter subtle mono" style={{ fontSize: 11, marginTop: 18, paddingBottom: 8 }}>
          Mesa · v1.0 · getmesa.co
        </p>
      </div>
    </div>
  )
}
