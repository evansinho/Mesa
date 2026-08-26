import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Users, Plus, LogOut, Bell, Inbox } from 'lucide-react'
import { api, type Wrapped } from '../lib/api'
import { clearSession, getSession } from '../lib/auth'

export default function AppShell() {
  const navigate = useNavigate()
  const session = getSession()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Polled rather than pushed: the sweep runs every 15 minutes, so a minute of
  // staleness on the badge costs nothing and a websocket for three people
  // would be infrastructure with no reader.
  const count = useQuery({
    queryKey: ['queue', 'count'],
    queryFn: () => api.get<Wrapped<{ open: number; unread: number }>>('/staff/queue/count').then((r) => r.data),
    refetchInterval: 60_000,
  })
  const unread = count.data?.unread ?? 0

  async function signOut() {
    // Best-effort: the server deletes the session row, but a failed call must
    // still clear the local one or the user is stuck on a dead token.
    await api.post('/staff/auth/logout').catch(() => {})
    clearSession()
    navigate({ to: '/login' })
  }

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Mesa Sales</h1>
        <span className="who">
          {session?.user.name} · {session?.user.role}
        </span>
        <Link to="/queue" className="bell" aria-label={`Work queue, ${unread} unread`}>
          <Bell size={18} />
          {/* Only the action tier can badge this. Celebrations land in the
              feed, because a badge that fires on good news stops meaning
              "something needs doing" within a week. */}
          {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
        </Link>
        <button
          onClick={signOut}
          aria-label="Sign out"
          style={{ background: 'none', border: 0, color: '#fff', opacity: .8, cursor: 'pointer' }}
        >
          <LogOut size={18} />
        </button>
      </header>

      <Outlet />

      <nav className="tabbar">
        <Link to="/queue" data-active={pathname === '/queue'}>
          <Inbox size={20} />
          Queue
        </Link>
        <Link to="/overview" data-active={pathname === '/overview'}>
          <LayoutDashboard size={20} />
          Overview
        </Link>
        <Link to="/prospects" data-active={pathname === '/prospects'}>
          <Users size={20} />
          Pipeline
        </Link>
        <Link to="/prospects/new" data-active={pathname === '/prospects/new'}>
          <Plus size={20} />
          Add
        </Link>
      </nav>
    </div>
  )
}
