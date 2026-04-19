import { getSession, clearSession } from './auth'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const session = getSession()
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type') && init?.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json')
  }
  if (session) {
    headers.set('Authorization', `Bearer ${session.token}`)
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers })
  if (res.status === 401) {
    clearSession()
    window.location.href = '/login'
  }
  return res
}
