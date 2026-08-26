/**
 * Seed the commercial layer with a realistic working set.
 *
 *   pnpm --filter @mesa/api seed:commercial
 *
 * Exists because the integration suite truncates every table it touches, so
 * any demo database gets wiped the moment tests run. Rerunning this is cheaper
 * than reconstructing the data by hand each time.
 *
 * Destructive: truncates the commercial tables and the merchant tables it
 * depends on. Refuses to run against a database whose name doesn't look like a
 * development or test one, because "seed the dashboard" should never be one
 * typo away from clearing production merchants.
 */
import { sql } from 'drizzle-orm'
import { config } from '@mesa/config'
import {
  closeDb, commercialTargets, getDb, merchants, merchantChannels, orders, prospects,
  prospectActivities, staff,
} from '@mesa/db'
import { hashPassword } from '../staff/password'

const DEMO_PASSWORD = 'mesa-demo-password'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000)
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000)

type MerchantSpec = {
  name: string
  phone: string
  tier: 'starter' | 'growth' | 'business'
  status: 'trialing' | 'active' | 'past_due' | 'expired' | 'cancelled'
  createdDaysAgo: number
  connectedDaysAgo?: number
  /** [order count, days ago the run starts] */
  orders?: [number, number]
  trialInDays?: number
  owner: 'founder' | 'lead' | 'rep'
  source: 'outbound' | 'referral' | 'instagram' | 'whatsapp' | 'partnership' | 'event' | 'organic' | 'inbound'
  detail?: string
}

// Chosen to exercise every lifecycle branch: paying and busy, paying and gone
// quiet, activated but not paying, connected with no orders, signed up but
// never connected, a trial about to lapse, a billing failure, and a churn.
const MERCHANTS: MerchantSpec[] = [
  { name: 'Chidi Sneakers',    phone: '+2348055512345', tier: 'growth',   status: 'active',    createdDaysAgo: 120, connectedDaysAgo: 118, orders: [6, 5],  owner: 'rep',     source: 'instagram',   detail: 'ig-ads-test' },
  { name: 'Mama Ngozi Foods',  phone: '+2348055512346', tier: 'business', status: 'active',    createdDaysAgo: 150, connectedDaysAgo: 148, orders: [9, 4],  owner: 'lead',    source: 'referral',    detail: 'market association' },
  { name: 'Bola Thrift',       phone: '+2348055512347', tier: 'starter',  status: 'active',    createdDaysAgo: 95,  connectedDaysAgo: 92,  orders: [4, 40], owner: 'rep',     source: 'whatsapp',    detail: 'vendor group' },
  { name: 'Sunmi Electronics', phone: '+2348055512348', tier: 'starter',  status: 'trialing',  createdDaysAgo: 20,  connectedDaysAgo: 12,                   owner: 'lead',    source: 'outbound',    detail: 'Computer Village' },
  { name: 'Kemi Beauty',       phone: '+2348055512349', tier: 'growth',   status: 'trialing',  createdDaysAgo: 12,  trialInDays: 1,                          owner: 'rep',     source: 'referral',    detail: 'referred by Chidi' },
  { name: 'Adeola Fabrics',    phone: '+2348055512350', tier: 'starter',  status: 'trialing',  createdDaysAgo: 4,                                            owner: 'founder', source: 'instagram',   detail: 'ig-dm-outreach' },
  { name: 'Ikeja Provisions',  phone: '+2348055512351', tier: 'starter',  status: 'past_due',  createdDaysAgo: 70,  connectedDaysAgo: 68,  orders: [3, 3],  owner: 'lead',    source: 'partnership', detail: 'POS agent network' },
  { name: 'Yaba Phone Hub',    phone: '+2348055512352', tier: 'growth',   status: 'cancelled', createdDaysAgo: 200, connectedDaysAgo: 198,                   owner: 'rep',     source: 'event',       detail: 'Lagos Startup Week' },
]

const PROSPECTS = [
  { name: 'Uche Auto Parts',  stage: 'SOURCED',   owner: 'rep',  source: 'outbound',    detail: 'Ladipo list',       daysAgo: 11 },
  { name: 'Zainab Textiles',  stage: 'CONTACTED', owner: 'rep',  source: 'instagram',   detail: 'ig-dm-outreach',    daysAgo: 6 },
  { name: 'Emeka Cold Store', stage: 'DEMOED',    owner: 'lead', source: 'referral',    detail: 'referred by Bola',  daysAgo: 3 },
  { name: 'Lekki Bakes',      stage: 'CONTACTED', owner: null,   source: 'organic',     detail: null,                daysAgo: 2 },
  { name: 'Surulere Spares',  stage: 'SOURCED',   owner: 'lead', source: 'partnership', detail: 'POS agent network', daysAgo: 9 },
] as const

async function main() {
  const url = config.DATABASE_URL
  const dbName = url.split('/').pop()?.split('?')[0] ?? ''
  if (!/dev|test|local/i.test(dbName)) {
    console.error(
      `Refusing to seed: database "${dbName}" does not look like a development database.\n` +
        'This script truncates merchant tables. Point DATABASE_URL at a dev or test database.',
    )
    process.exit(1)
  }

  const db = getDb(url)

  // commercial_targets is truncated too, by the CASCADE from staff — its
  // created_by references it — so the target is reinserted below rather than
  // left to the migration's one-time row.
  await db.execute(sql`
    TRUNCATE staff_notifications, merchant_lifecycle_events, prospect_activities, prospects,
             staff_sessions, staff, orders, merchant_channels, conversations, merchants,
             commercial_targets
    RESTART IDENTITY CASCADE
  `)

  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const [founder] = await db.insert(staff).values({
    name: 'Evanson Igiri', email: 'evanson@getmesa.co', passwordHash,
    role: 'admin', mustResetPassword: false, refCode: 'EV',
  }).returning()
  const [lead] = await db.insert(staff).values({
    name: 'Amaka Obi', email: 'amaka@getmesa.co', passwordHash,
    role: 'manager', mustResetPassword: false, refCode: 'AO',
  }).returning()
  const [rep] = await db.insert(staff).values({
    name: 'Tunde Bello', email: 'tunde@getmesa.co', passwordHash,
    role: 'member', mustResetPassword: false, refCode: 'TB',
  }).returning()

  await db.insert(commercialTargets).values({
    label: 'Q4 milestone',
    metric: 'merchants_on_mesa',
    target: 50,
    createdBy: founder.id,
  })

  const owners = { founder: founder.id, lead: lead.id, rep: rep.id }

  for (const spec of MERCHANTS) {
    const [m] = await db.insert(merchants).values({
      name: spec.name,
      phone: spec.phone,
      subscriptionTier: spec.tier,
      subscriptionStatus: spec.status,
      trialEndsAt: spec.trialInDays !== undefined
        ? inDays(spec.trialInDays)
        : daysAgo(Math.max(spec.createdDaysAgo - 14, 1)),
      createdAt: spec.createdDaysAgo < 1 ? hoursAgo(6) : daysAgo(spec.createdDaysAgo),
      config: {},
    }).returning()

    await db.insert(prospects).values({
      businessName: spec.name,
      phone: spec.phone,
      phoneNormalized: spec.phone,
      source: spec.source,
      sourceDetail: spec.detail ?? null,
      ownerId: owners[spec.owner],
      merchantId: m.id,
      matchStatus: 'auto',
      matchedAt: daysAgo(spec.createdDaysAgo),
      stage: 'DEMOED',
      createdAt: daysAgo(spec.createdDaysAgo + 7),
    })

    if (spec.connectedDaysAgo !== undefined) {
      await db.insert(merchantChannels).values({
        merchantId: m.id,
        channel: 'whatsapp',
        channelAccountId: `wa-${m.id.slice(0, 8)}`,
        status: 'connected',
        connectedAt: daysAgo(spec.connectedDaysAgo),
      })
    }

    if (spec.orders) {
      const [count, startDaysAgo] = spec.orders
      const [convo] = (
        await db.execute<{ id: string }>(sql`
          INSERT INTO conversations (merchant_id, channel, customer_phone, state, context)
          VALUES (${m.id}, 'whatsapp', '+2348090000000', 'IDLE', '{}'::jsonb)
          RETURNING id
        `)
      ).rows as { id: string }[]

      for (let i = 0; i < count; i++) {
        await db.insert(orders).values({
          merchantId: m.id,
          conversationId: convo.id,
          customerPhone: '+2348090000000',
          status: 'PAID',
          subtotal: '8500.00',
          total: '8500.00',
          createdAt: daysAgo(startDaysAgo + i),
        })
      }
    }
  }

  for (const p of PROSPECTS) {
    const digits = Math.floor(Math.random() * 90_000_000 + 10_000_000)
    const phone = `+23480${digits}`
    const [row] = await db.insert(prospects).values({
      businessName: p.name,
      phone,
      phoneNormalized: phone,
      source: p.source,
      sourceDetail: p.detail,
      ownerId: p.owner ? owners[p.owner] : null,
      stage: p.stage,
      createdAt: daysAgo(p.daysAgo),
    }).returning()

    if (p.stage !== 'SOURCED' && p.owner) {
      await db.insert(prospectActivities).values({
        prospectId: row.id,
        staffId: owners[p.owner],
        type: 'whatsapp',
        body: 'Sent intro and pricing. Waiting on a reply.',
        occurredAt: daysAgo(Math.max(p.daysAgo - 1, 0)),
      })
    }
  }

  console.log(`\nSeeded ${MERCHANTS.length} merchants and ${PROSPECTS.length} pre-signup prospects.`)
  console.log('Staff:')
  console.log('  evanson@getmesa.co  admin')
  console.log('  amaka@getmesa.co    manager')
  console.log('  tunde@getmesa.co    member')
  console.log(`  password (all three): ${DEMO_PASSWORD}`)
  console.log('\nRun the worker, or the sweep directly, to populate lifecycle state and the queue.\n')

  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
