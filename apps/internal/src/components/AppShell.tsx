import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Inbox, LayoutDashboard, Columns3, Store, Users, Plus, LogOut, Bell } from 'lucide-react'
import { api, type Wrapped } from '../lib/api'
import { clearSession, getSession } from '../lib/auth'

// Sidebar order and the title shown in the topbar, in one place.
const NAV = [
  { to: '/queue', label: 'Queue', icon: Inbox, title: 'Work queue', sub: 'What needs you today' },
  { to: '/overview', label: 'Overview', icon: LayoutDashboard, title: 'Overview', sub: 'Pipeline health and activation' },
  { to: '/pipeline', label: 'Pipeline', icon: Columns3, title: 'Pipeline', sub: 'Every account by stage' },
  { to: '/merchants', label: 'Merchants', icon: Store, title: 'Merchants', sub: 'Everyone on Mesa' },
  { to: '/team', label: 'Team', icon: Users, title: 'Team', sub: 'Attribution and MRR booked' },
] as const

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
}

export default function AppShell() {
  const navigate = useNavigate()
  const session = getSession()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Polled, not pushed. The sweep runs every 15 minutes, so a minute of
  // staleness on a badge costs nothing and a socket for three people would be
  // infrastructure with no reader.
  const counts = useQuery({
    queryKey: ['queue', 'count'],
    queryFn: () =>
      api.get<Wrapped<{ open: number; unread: number }>>('/staff/queue/count').then((r) => r.data),
    refetchInterval: 60_000,
  })

  const milestone = useQuery({
    queryKey: ['dashboard'],
    queryFn: () =>
      api
        .get<Wrapped<{ kpis: { signedUp: number }; milestone?: { target: number } }>>('/staff/dashboard')
        .then((r) => r.data),
  })

  const unread = counts.data?.unread ?? 0
  const open = counts.data?.open ?? 0
  const paying = milestone.data?.kpis.signedUp ?? 0
  const target = milestone.data?.milestone?.target ?? 50
  const pct = Math.min(100, Math.round((paying / Math.max(target, 1)) * 100))

  const active = NAV.find((n) => n.to === pathname) ?? NAV[0]

  async function signOut() {
    // Best effort. A failed call must still clear the local session or the
    // user is stranded on a dead token.
    await api.post('/staff/auth/logout').catch(() => {})
    clearSession()
    navigate({ to: '/login' })
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img src="/mark-tile.svg" alt="" />
          <span className="wordmark">
            mesa<span className="dot">.</span>
          </span>
          <span className="topbar-chip">Sales</span>
        </div>

        <div className="desktop-only">
          <div className="view-title">{active.title}</div>
          <div className="view-sub">{active.sub}</div>
        </div>

        <div className="topbar-actions">
          <Link to="/queue" className="icon-btn" aria-label={`Work queue, ${unread} unread`}>
            <Bell size={18} />
            {/* Only the action tier reaches this. Celebrations land in the feed,
                because a badge that fires on good news stops meaning
                "something needs doing" within a week. */}
            {unread > 0 && <span className="badge-count">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <Link to="/prospects/new" className="btn btn--primary btn--sm cta">
            <Plus size={15} />
            <span className="cta-label">Add prospect</span>
          </Link>
          <button className="icon-btn mobile-only" onClick={signOut} aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <Outlet />

      <nav className="tabbar">
        <div className="rail-brand desktop-only">
          <img src="/mark-tile.svg" alt="" />
          <span className="wordmark">
            mesa<span className="dot">.</span>
          </span>
        </div>
        <div className="rail-tag desktop-only">Sales console · internal</div>

        {NAV.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.to
          return (
            <Link key={item.to} to={item.to} data-active={isActive}>
              <span className="tab-chip">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              {item.label}
              {item.to === '/queue' && open > 0 && (
                <span className="rail-count desktop-only">{open}</span>
              )}
            </Link>
          )
        })}

        <div className="rail-foot desktop-only">
          <div className="rail-sep" />

          {/* Pinned bottom. The one number the founder is actually tracking, in
              the one place it stays visible across every view. */}
          <div className="milestone">
            <span className="m-lab">Q4 milestone</span>
            <span className="m-val">
              {paying} <span>/ {target} on Mesa</span>
            </span>
            <div className="m-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <span className="m-note">{pct}% there</span>
          </div>

          <div className="rail-user">
            <span className="ru-av">{initials(session?.user.name ?? '')}</span>
            <div className="stack" style={{ flex: 1, minWidth: 0 }}>
              <span className="ru-n truncate">{session?.user.name}</span>
              <span className="ru-r">{session?.user.role}</span>
            </div>
            <button className="icon-btn" onClick={signOut} aria-label="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </nav>
    </div>
  )
}
