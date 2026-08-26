import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Inbox, LayoutDashboard, Columns3, ClipboardList, Store, Users, Plus, LogOut, Bell } from 'lucide-react'
import { api, type Wrapped } from '../lib/api'
import { clearSession, getSession } from '../lib/auth'
import { useDashboard } from '../lib/dashboard'

// Sidebar order and the title shown in the topbar, in one place.
//
// `roles` hides an item the caller cannot use at all. A tab that is visible,
// clickable, and then answers 403 is worse than no tab: it advertises a
// capability and then denies it. This is presentation only — the server still
// refuses the request, because the role here comes from localStorage.
const NAV = [
  { to: '/queue', label: 'Queue', icon: Inbox, title: 'Work queue', sub: 'What needs you today' },
  { to: '/overview', label: 'Overview', icon: LayoutDashboard, title: 'Overview', sub: 'Pipeline health and activation' },
  { to: '/prospects', label: 'Prospects', icon: ClipboardList, title: 'Prospects', sub: 'Everything before signup' },
  { to: '/pipeline', label: 'Pipeline', icon: Columns3, title: 'Pipeline', sub: 'Every account by stage' },
  { to: '/merchants', label: 'Merchants', icon: Store, title: 'Merchants', sub: 'Everyone on Mesa' },
  {
    to: '/team', label: 'Team', icon: Users, title: 'Team',
    sub: 'People, attribution and targets',
    roles: ['admin', 'manager'] as const,
  },
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

  const dashboard = useDashboard()

  const unread = counts.data?.unread ?? 0
  const open = counts.data?.open ?? 0
  // The company number, not the caller's slice — the rail must read the same
  // for a rep and for the founder.
  const paying = dashboard.data?.milestone.actual ?? 0
  const target = dashboard.data?.milestone.target ?? 50
  const milestoneLabel = dashboard.data?.milestone.label ?? 'Milestone'
  const pct = Math.min(100, Math.round((paying / Math.max(target, 1)) * 100))

  // Detail routes are not in NAV. Falling back to NAV[0] made every prospect
  // record claim to be the work queue, so they get their own titles.
  const role = session?.user.role ?? 'member'
  const nav = NAV.filter((n) => !('roles' in n) || (n.roles as readonly string[]).includes(role))

  // Trailing slashes are why the list page titled itself "Prospect · Record and
  // activity": /prospects/ matched the detail branch. Normalise before matching.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  const active =
    NAV.find((n) => n.to === path) ??
    (path === '/prospects/new'
      ? { title: 'Add prospect', sub: 'Source a new merchant' }
      : path.startsWith('/prospects/')
        ? { title: 'Prospect', sub: 'Record and activity' }
        : { title: 'Mesa Sales', sub: 'Internal' })

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

        {nav.map((item) => {
          const Icon = item.icon
          const isActive = path === item.to
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
            <span className="m-lab">{milestoneLabel}</span>
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
