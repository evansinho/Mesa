/**
 * Normalize a Nigerian phone number to E.164 (`+234XXXXXXXXXX`).
 *
 * Consolidated from five byte-identical copies that had drifted across
 * `apps/api`, `apps/worker` and `apps/gateway`. They agreed at the time of
 * extraction — keeping them separate meant a fix to one silently leaving the
 * other four wrong, which matters now that prospect→merchant matching in the
 * commercial layer joins on the normalized form.
 *
 * Deliberately lenient: strips all non-digits, drops a leading `234` country
 * code or a leading national `0`, then re-prefixes. It does not validate
 * length or operator prefix — callers that need a real validity check should
 * do it separately.
 */
export function normalizePhone(raw: string): string {
  // Deliberately strict rather than returning '' for bad input: a caller that
  // silently normalizes undefined into a valid-looking string would go on to
  // query for it, and a wrong lookup is worse than a loud failure. The message
  // names the problem, because the previous TypeError surfaced in production as
  // "Cannot read properties of undefined (reading 'replace')" three frames deep
  // in a shared package, which says nothing about which caller was at fault.
  if (typeof raw !== 'string') {
    throw new TypeError(`normalizePhone expected a string, received ${typeof raw}`)
  }

  const digits = raw.replace(/\D/g, '')
  const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${national}`
}
