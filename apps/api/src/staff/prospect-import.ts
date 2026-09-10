import { inArray } from 'drizzle-orm'
import { normalizePhone } from '@mesa/types'
import { merchants, prospects, type Db } from '@mesa/db'
import type { RawRow } from './import-rows'

/** Re-exported so routes take one import for the request shape. */
export type RawRowInput = RawRow

export const MAX_IMPORT_ROWS = 1000

/**
 * Normalise a phone, or return null if the result is not a usable join key.
 *
 * `normalizePhone` only throws on a non-string: it strips non-digits, so
 * "not a number" and "" both come back as the bare country code `+234`. Left
 * unchecked that is worse than a crash — every unusable row in a file collapses
 * onto the same key, so the first one is imported as a prospect whose phone can
 * never match a signup, and the rest are reported as duplicates of it.
 *
 * Nigerian mobile numbers are ten national digits opening 7, 8 or 9.
 */
function toJoinKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  let normalized: string
  try {
    normalized = normalizePhone(raw)
  } catch {
    return null
  }
  const national = normalized.replace(/\D/g, '').replace(/^234/, '')
  if (national.length !== 10 || !/^[789]/.test(national)) return null
  return normalized
}

export type SkipReason =
  | 'bad_phone'          // could not be normalised, so it can never match a merchant
  | 'no_business_name'
  | 'already_a_merchant'
  | 'already_a_prospect'
  | 'duplicate_in_file'

export interface PlannedRow {
  line: number
  businessName: string | null
  phone: string
  phoneNormalized: string | null
  instagramHandle: string | null
  contactName: string | null
  sourceDetail: string | null
}

export interface ImportPlan {
  create: PlannedRow[]
  skip: (PlannedRow & { reason: SkipReason; detail?: string })[]
  counts: Record<'total' | 'create' | SkipReason, number>
}

/**
 * Decide what an import would do, without doing it.
 *
 * The preview the console shows and the rows the import writes both come from
 * here. That is the point: a preview computed by different code from the write
 * is a preview that can lie, and this one writes straight to the table the
 * sales team works out of, with no undo.
 */
export async function planImport(
  db: Db,
  rows: RawRow[],
  opts: { requireBusinessName?: boolean } = {},
): Promise<ImportPlan> {
  const plan: ImportPlan = {
    create: [],
    skip: [],
    counts: {
      total: rows.length,
      create: 0,
      bad_phone: 0,
      no_business_name: 0,
      already_a_merchant: 0,
      already_a_prospect: 0,
      duplicate_in_file: 0,
    },
  }

  // Normalise first so every later check keys off the same value the database
  // uses. A row we cannot normalise is dropped here: without a join key it
  // could never be matched to a merchant on signup, which is the one thing a
  // prospect record exists to make possible.
  const staged: PlannedRow[] = rows.map((row, i) => {
    const phoneNormalized = toJoinKey(row.phone)
    return {
      line: i + 1,
      businessName: row.businessName?.trim() || null,
      phone: String(row.phone ?? '').trim(),
      phoneNormalized,
      instagramHandle: row.instagramHandle?.trim().replace(/^@/, '') || null,
      contactName: row.contactName?.trim() || null,
      sourceDetail: row.sourceDetail?.trim() || null,
    }
  })

  const candidates = staged.filter((r) => r.phoneNormalized !== null)
  const numbers = [...new Set(candidates.map((r) => r.phoneNormalized!))]

  // Two queries for the whole file rather than two per row.
  const [existingMerchants, existingProspects] = numbers.length === 0
    ? [[], []]
    : await Promise.all([
        db.select({ id: merchants.id, phone: merchants.phone, name: merchants.name })
          .from(merchants).where(inArray(merchants.phone, numbers)),
        db.select({
          id: prospects.id,
          phoneNormalized: prospects.phoneNormalized,
          businessName: prospects.businessName,
        }).from(prospects).where(inArray(prospects.phoneNormalized, numbers)),
      ])

  const merchantByPhone = new Map(existingMerchants.map((m) => [m.phone, m]))
  const prospectByPhone = new Map(existingProspects.map((p) => [p.phoneNormalized, p]))

  const seenInFile = new Set<string>()

  for (const row of staged) {
    const skip = (reason: SkipReason, detail?: string) => {
      plan.skip.push({ ...row, reason, detail })
      plan.counts[reason] += 1
    }

    if (row.phoneNormalized === null) { skip('bad_phone'); continue }
    if (opts.requireBusinessName && !row.businessName) { skip('no_business_name'); continue }

    const merchant = merchantByPhone.get(row.phoneNormalized)
    if (merchant) {
      // The most valuable skip in the set. Importing this row would put an
      // existing customer into the outbound pipeline for someone to cold-call.
      skip('already_a_merchant', merchant.name)
      continue
    }

    const prospect = prospectByPhone.get(row.phoneNormalized)
    if (prospect) { skip('already_a_prospect', prospect.businessName); continue }

    // Within the file itself. A pasted range very often repeats a number, and
    // two prospects for one business means two owners and two people calling.
    if (seenInFile.has(row.phoneNormalized)) { skip('duplicate_in_file'); continue }

    seenInFile.add(row.phoneNormalized)
    plan.create.push(row)
  }

  plan.counts.create = plan.create.length
  return plan
}
