import { staffAuditLog, type Db } from '@mesa/db'
import type { ApiAuth } from '../auth-context'

type StaffAuth = Extract<ApiAuth, { kind: 'staff' }>

/**
 * Record a staff action.
 *
 * Fire-and-forget by design: an audit write must never fail the request that
 * produced it, or a full disk turns into an outage. Failures are logged and
 * swallowed. If audit ever becomes compliance-critical this needs to become
 * transactional instead — noted rather than assumed.
 */
export async function audit(
  db: Db,
  auth: StaffAuth,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(staffAuditLog).values({
      staffId: auth.staffId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      metadata,
    })
  } catch (err) {
    console.error('[staff-audit] failed to record action', { action, err })
  }
}
