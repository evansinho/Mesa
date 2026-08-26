import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api, ApiError, type Wrapped } from '../lib/api'
import { getSession, setSession } from '../lib/auth'

const MIN_LENGTH = 12

export default function ChangePasswordPage() {
  const navigate = useNavigate()
  const session = getSession()
  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== newPassword

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (tooShort || mismatch) return
    setBusy(true)
    setError(null)
    try {
      // Changing the password revokes every other session server-side and
      // returns a fresh token for this one, so we swap it in rather than
      // bouncing the user back to the login screen.
      const res = await api.post<Wrapped<{ token: string; expiresAt: string }>>(
        '/staff/auth/change-password',
        { currentPassword, newPassword },
      )
      if (session) {
        setSession({
          token: res.data.token,
          user: { ...session.user, mustResetPassword: false },
        })
      }
      navigate({ to: '/overview' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Set your password</h1>
        <p className="sub">
          {session?.user.mustResetPassword
            ? 'Your account was created with a temporary password. Choose your own to continue.'
            : 'Signing out of every other device.'}
        </p>

        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="current">Current password</label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="new">New password</label>
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            required
          />
          <div className="hint">
            {tooShort ? `At least ${MIN_LENGTH} characters.` : `${MIN_LENGTH} characters minimum.`}
          </div>
        </div>

        <div className="field">
          <label htmlFor="confirm">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {mismatch && <div className="hint" style={{ color: 'var(--danger)' }}>Passwords don’t match.</div>}
        </div>

        <button className="btn wide" type="submit" disabled={busy || tooShort || mismatch}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
  )
}
