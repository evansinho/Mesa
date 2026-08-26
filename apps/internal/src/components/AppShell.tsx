import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { Users, Plus, LogOut } from 'lucide-react'
import { api } from '../lib/api'
import { clearSession, getSession } from '../lib/auth'

export default function AppShell() {
  const navigate = useNavigate()
  const session = getSession()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

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
        <Link to="/prospects" data-active={pathname.startsWith('/prospects') && pathname === '/prospects'}>
          <Users size={20} />
          Prospects
        </Link>
        <Link to="/prospects/new" data-active={pathname === '/prospects/new'}>
          <Plus size={20} />
          Add
        </Link>
      </nav>
    </div>
  )
}
