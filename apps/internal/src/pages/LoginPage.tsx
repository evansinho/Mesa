import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError, type Wrapped } from '../lib/api'
import { setSession, type StaffSession } from '../lib/auth'

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<Wrapped<StaffSession & { expiresAt: string }>>(
        '/staff/auth/login',
        { email, password },
      )
      setSession({ token: res.data.token, user: res.data.user })
      // A forced password change is a hard gate, not a suggestion — the
      // bootstrap script prints the temporary password to a terminal.
      navigate({ to: res.data.user.mustResetPassword ? '/change-password' : '/overview' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Mesa Sales</h1>
        <p className="sub">Internal — staff accounts only.</p>

        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button className="btn wide" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
