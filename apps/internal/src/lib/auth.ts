const SESSION_KEY = 'mesa_staff_session'

export type StaffRole = 'admin' | 'manager' | 'member'

export type StaffSession = {
  token: string
  user: {
    id: string
    name: string
    email: string
    role: StaffRole
    mustResetPassword: boolean
  }
}

export function getSession(): StaffSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as StaffSession) : null
  } catch {
    return null
  }
}

export function setSession(session: StaffSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

/**
 * Role helpers for showing and hiding UI.
 *
 * Presentation only. The role in localStorage is trivially editable, so these
 * decide what a button looks like and never what the server will allow — every
 * /staff/* endpoint re-checks the role against the database row.
 */
export function isManager(session: StaffSession | null): boolean {
  return session?.user.role === 'admin' || session?.user.role === 'manager'
}
