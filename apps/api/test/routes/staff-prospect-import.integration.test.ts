import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { prospects, staffAuditLog } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createProspect, createMerchant } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await registerStaffRoutes(app, db)
  return app
}

async function actor(role: 'admin' | 'manager' | 'member') {
  const db = getTestDb()
  const member = await createStaff(db, { role })
  const token = await createStaffSession(db, member.id)
  return { member, headers: { authorization: `Bearer ${token}` } }
}

const csv = (...lines: string[]) => ['business_name,phone', ...lines].join('\n')

async function importCsv(
  app: FastifyInstance,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  const res = await app.inject({
    method: 'POST', url: '/staff/prospects/import', headers, payload: { source: 'outbound', ...body },
  })
  return { status: res.statusCode, body: res.json() }
}

describe('POST /staff/prospects/import — the happy path', () => {
  it('creates a prospect per row, at stage SOURCED', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { status, body } = await importCsv(app, me.headers, {
      text: csv('Mama Ronke Kitchen,08039999999', 'Bimpe Thrift,08051234567'),
    })

    expect(status).toBe(201)
    expect(body.data.counts.create).toBe(2)
    expect(body.data.created).toHaveLength(2)

    const rows = await db.select().from(prospects)
    expect(rows).toHaveLength(2)
    // SOURCED is honest for a list a person researched and uploaded.
    expect(rows.every((r) => r.stage === 'SOURCED')).toBe(true)
    // Normalised to the join key that merchant matching depends on.
    expect(rows.map((r) => r.phoneNormalized).sort())
      .toEqual(['+2348039999999', '+2348051234567'])
  })

  it('reads a pasted spreadsheet range', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    await importCsv(app, me.headers, {
      text: 'Name\tPhone\tContact\nRonke Foods, Lekki\t08039999999\tRonke\n',
    })

    const [row] = await db.select().from(prospects)
    expect(row.businessName).toBe('Ronke Foods, Lekki')
    expect(row.contactName).toBe('Ronke')
  })

  it('assigns the import to whoever ran it', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    await importCsv(app, me.headers, { text: csv('Ronke,08039999999') })

    const [row] = await db.select().from(prospects)
    expect(row.ownerId).toBe(me.member.id)
  })

  it('leaves the list in the claimable pool when ownerId is explicitly null', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    await importCsv(app, me.headers, { text: csv('Ronke,08039999999'), ownerId: null })

    const [row] = await db.select().from(prospects)
    expect(row.ownerId).toBeNull()
  })

  it('records the source on every row, and lets a per-row detail win', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    await importCsv(app, me.headers, {
      text: 'name,phone,notes\nA,08039999999,found at Balogun\nB,08051234567,\n',
      source: 'referral',
      sourceDetail: 'March sweep',
    })

    const rows = await db.select().from(prospects)
    expect(rows.every((r) => r.source === 'referral')).toBe(true)
    // A mixed list can say where each individual name came from.
    expect(rows.find((r) => r.businessName === 'A')!.sourceDetail).toBe('found at Balogun')
    expect(rows.find((r) => r.businessName === 'B')!.sourceDetail).toBe('March sweep')
  })

  it('writes one audit entry for the import, not one per row', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    await importCsv(app, me.headers, {
      text: csv('A,08039999999', 'B,08051234567', 'C,08061234567'),
    })

    const entries = await db.select().from(staffAuditLog)
      .where(eq(staffAuditLog.action, 'prospect:import'))
    expect(entries).toHaveLength(1)
    expect(entries[0].metadata).toMatchObject({ createdCount: 3, source: 'outbound' })
  })
})

describe('POST /staff/prospects/import — what it refuses to create', () => {
  it('skips a number that already belongs to a merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')
    await createMerchant(db, { phone: '+2348039999999', name: 'Already A Customer' })

    const { body } = await importCsv(app, me.headers, {
      text: csv('Already A Customer,08039999999', 'Genuinely New,08051234567'),
    })

    expect(body.data.counts.create).toBe(1)
    expect(body.data.counts.already_a_merchant).toBe(1)
    // Named, so the operator can see who it was rather than a bare count.
    expect(body.data.skip[0]).toMatchObject({
      reason: 'already_a_merchant', detail: 'Already A Customer',
    })
    // The one that matters: an existing customer must not enter the outbound
    // pipeline for someone to cold-call.
    expect(await db.select().from(prospects)).toHaveLength(1)
  })

  it('skips a number that is already a prospect', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')
    await createProspect(db, {
      phone: '+2348039999999', phoneNormalized: '+2348039999999', businessName: 'Known Lead',
    })

    const { body } = await importCsv(app, me.headers, { text: csv('Known Lead,08039999999') })

    expect(body.data.counts.already_a_prospect).toBe(1)
    expect(await db.select().from(prospects)).toHaveLength(1)
  })

  it('skips a number repeated within the same file', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { body } = await importCsv(app, me.headers, {
      text: csv('Ronke Foods,08039999999', 'Ronke Foods NG,08039999999'),
    })

    // Two prospects for one business means two owners and two people calling.
    expect(body.data.counts.duplicate_in_file).toBe(1)
    expect(await db.select().from(prospects)).toHaveLength(1)
  })

  it('matches duplicates across differently formatted numbers', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')
    await createMerchant(db, { phone: '+2348039999999' })

    const { body } = await importCsv(app, me.headers, {
      text: csv('A,08039999999', 'B,2348039999999', 'C,+234 803 999 9999'),
    })

    // All three are the same line written three ways.
    expect(body.data.counts.create).toBe(0)
    expect(body.data.counts.already_a_merchant + body.data.counts.duplicate_in_file).toBe(3)
  })

  it('skips a row with no usable phone', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { body } = await importCsv(app, me.headers, {
      rows: [{ businessName: 'A', phone: 'not a number' }, { businessName: 'B', phone: '08051234567' }],
    })

    // Without a join key it could never be matched to a merchant on signup,
    // which is the one thing a prospect record exists to make possible.
    expect(body.data.counts.bad_phone).toBe(1)
    expect(body.data.counts.create).toBe(1)
  })

  it('does not let several unusable numbers collapse onto one key', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { body } = await importCsv(app, me.headers, {
      rows: [
        { businessName: 'A', phone: 'not a number' },
        { businessName: 'B', phone: '' },
        { businessName: 'C', phone: 'call me' },
        { businessName: 'D', phone: '0803' },          // too short
        { businessName: 'E', phone: '01234567890' },    // landline, not 7/8/9
        { businessName: 'F', phone: '08051234567' },
      ],
    })

    // normalizePhone strips non-digits rather than throwing, so all five of
    // these used to normalise to the bare '+234'. The first was imported as a
    // prospect whose phone could never match a signup, and the other four were
    // reported as duplicates of it.
    expect(body.data.counts.bad_phone).toBe(5)
    expect(body.data.counts.duplicate_in_file).toBe(0)
    expect(body.data.counts.create).toBe(1)

    const rows = await db.select().from(prospects)
    expect(rows).toHaveLength(1)
    expect(rows[0].phoneNormalized).toBe('+2348051234567')
  })

  it('skips a row with no business name', async () => {
    const app = await buildApp()
    const me = await actor('member')

    const { body } = await importCsv(app, me.headers, {
      text: 'name,phone\n,08039999999\nReal Business,08051234567\n',
    })

    expect(body.data.counts.no_business_name).toBe(1)
    expect(body.data.counts.create).toBe(1)
  })

  it('reports the parse errors alongside the plan', async () => {
    const app = await buildApp()
    const me = await actor('member')

    const { body } = await importCsv(app, me.headers, {
      text: 'name,phone\nGood,08039999999\nNoPhone,\n',
    })

    expect(body.data.parseErrors).toEqual([{ line: 3, reason: 'no phone' }])
    expect(body.data.counts.create).toBe(1)
  })
})

describe('POST /staff/prospects/import — the preview', () => {
  it('writes nothing on a dry run', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { status, body } = await importCsv(app, me.headers, {
      text: csv('A,08039999999', 'B,08051234567'), dryRun: true,
    })

    expect(status).toBe(200)
    expect(body.data.counts.create).toBe(2)
    expect(body.data.dryRun).toBe(true)
    expect(await db.select().from(prospects)).toHaveLength(0)
  })

  it('predicts exactly what the real run then does', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')
    await createMerchant(db, { phone: '+2348039999999' })
    await createProspect(db, { phone: '+2348051234567', phoneNormalized: '+2348051234567' })

    const text = csv(
      'Existing Customer,08039999999',
      'Known Lead,08051234567',
      'New One,08061234567',
      'New One Again,08061234567',
      ',08071234567',
    )

    const preview = await importCsv(app, me.headers, { text, dryRun: true })
    const real = await importCsv(app, me.headers, { text })

    // The property that makes the preview trustworthy. Computed by the same
    // code, so it cannot drift from the write.
    expect(real.body.data.counts).toEqual(preview.body.data.counts)
    expect(real.body.data.created).toHaveLength(preview.body.data.counts.create)
  })
})

describe('POST /staff/prospects/import — limits and permissions', () => {
  it('rejects an import over the row limit instead of truncating it', async () => {
    const app = await buildApp()
    const me = await actor('member')

    const rows = Array.from({ length: 1001 }, (_, i) => ({
      businessName: `B${i}`, phone: `+23480${String(31_000_000 + i)}`,
    }))
    const { status, body } = await importCsv(app, me.headers, { rows })

    // Silently importing the first 1000 would look like it worked.
    expect(status).toBe(413)
    expect(body.error).toContain('exceeds the 1000-row limit')
  })

  it('imports a large-but-legal file in one transaction', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const rows = Array.from({ length: 750 }, (_, i) => ({
      businessName: `B${i}`, phone: `+23480${String(31_000_000 + i)}`,
    }))
    const { status } = await importCsv(app, me.headers, { rows })

    expect(status).toBe(201)
    expect(await db.select().from(prospects)).toHaveLength(750)
  })

  it('lets a manager hand an import to another rep', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const rep = await actor('member')

    await importCsv(app, boss.headers, { text: csv('A,08039999999'), ownerId: rep.member.id })

    expect((await db.select().from(prospects))[0].ownerId).toBe(rep.member.id)
  })

  it('ignores a member trying to assign the import to someone else', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')
    const other = await actor('member')

    await importCsv(app, me.headers, { text: csv('A,08039999999'), ownerId: other.member.id })

    // Falls back to the importer rather than erroring, matching how the
    // single-create route already behaves.
    expect((await db.select().from(prospects))[0].ownerId).toBe(me.member.id)
  })

  it('rejects an unknown source', async () => {
    const app = await buildApp()
    const me = await actor('member')
    const { status, body } = await importCsv(app, me.headers, {
      text: csv('A,08039999999'), source: 'linkedin',
    })
    expect(status).toBe(400)
    expect(body.error).toContain('source must be one of')
  })

  it('rejects a file with no phone column before doing anything', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor('member')

    const { status, body } = await importCsv(app, me.headers, {
      text: 'name,location\nRonke,Lagos\n',
    })

    expect(status).toBe(400)
    expect(body.error).toContain('no phone column')
    expect(await db.select().from(prospects)).toHaveLength(0)
  })

  it('needs a session', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/staff/prospects/import',
      payload: { source: 'outbound', text: csv('A,08039999999') },
    })
    expect(res.statusCode).toBe(401)
  })
})
