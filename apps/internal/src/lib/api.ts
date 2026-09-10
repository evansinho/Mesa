import { clearSession, getSession } from './auth'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3002'

function isCredentialExchange(path: string): boolean {
  return path === '/staff/auth/login' || path === '/staff/auth/change-password'
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = getSession()
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type') && init?.body) headers.set('Content-Type', 'application/json')
  if (session) headers.set('Authorization', `Bearer ${session.token}`)

  const res = await fetch(`${API_URL}${path}`, { ...init, headers })

  // 204 carries no body, so parsing is skipped rather than swallowed.
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}))

  if (res.status === 401) {
    // The login route is the one place a 401 is not a lapsed session — it means
    // the credentials were wrong. Blanket-replacing the server's message here
    // told anyone who fat-fingered their password that their session had
    // expired, which is both untrue and unactionable.
    if (isCredentialExchange(path)) {
      throw new ApiError(401, (body as { error?: string }).error ?? 'Invalid credentials')
    }

    // Everywhere else: staff sessions are short-lived with no refresh token, so
    // a 401 means log in again rather than silently retrying.
    clearSession()
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login'
    throw new ApiError(401, 'Session expired')
  }

  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ─── Shared response shapes ─────────────────────────────────────────────────

export type Paged<T> = { data: T; meta: { page: number; limit: number; total: number; pages: number } }
export type Wrapped<T> = { data: T }

export type ProspectStage = 'SOURCED' | 'CONTACTED' | 'DEMOED' | 'DISQUALIFIED' | 'DORMANT'

export type ProspectSource =
  | 'outbound' | 'referral' | 'instagram' | 'whatsapp'
  | 'partnership' | 'event' | 'organic' | 'inbound'

/** The shape POST /staff/prospects/import returns, for a dry run or a real one. */
export type ImportSkipReason =
  | 'bad_phone'
  | 'no_business_name'
  | 'already_a_merchant'
  | 'already_a_prospect'
  | 'duplicate_in_file'

export type ImportPlannedRow = {
  line: number
  businessName: string | null
  phone: string
  phoneNormalized: string | null
  instagramHandle: string | null
  contactName: string | null
  sourceDetail: string | null
}

export type ImportPlan = {
  create: ImportPlannedRow[]
  skip: (ImportPlannedRow & { reason: ImportSkipReason; detail?: string })[]
  counts: Record<'total' | 'create' | ImportSkipReason, number>
  parseErrors: { line: number; reason: string }[]
  columns: Record<string, string | null>
  ownerId: string | null
  dryRun: boolean
  created?: Prospect[]
}

export type Prospect = {
  id: string
  businessName: string
  phone: string
  phoneNormalized: string
  instagramHandle: string | null
  contactName: string | null
  stage: ProspectStage
  disqualifyReason: string | null
  disqualifyNote: string | null
  source: ProspectSource
  sourceDetail: string | null
  ownerId: string | null
  merchantId: string | null
  matchStatus: 'unmatched' | 'auto' | 'manual' | 'ambiguous'
  matchedAt: string | null
  createdAt: string
  updatedAt: string
  owner?: { id: string; name: string } | null
}

export type Activity = {
  id: string
  type: 'note' | 'call' | 'whatsapp' | 'demo' | 'meeting'
  body: string
  occurredAt: string
  staffId: string
  staffName: string | null
}
