/**
 * Run the commercial sweep once, out of band.
 *
 *   pnpm --filter @mesa/worker sweep
 *
 * The worker runs this every 15 minutes on a cron. This is for when you want it
 * now: after seeding, after changing a threshold, or to see what a rule change
 * would do before waiting for the next tick.
 */
import { config } from '@mesa/config'
import { closeDb, getDb } from '@mesa/db'
import { runLifecycleSweep } from '../commercial/sweep'
import {
  reconcileNotifications, emitFeedNotifications, escalateStaleNotifications,
} from '../commercial/notifications'

async function main() {
  const db = getDb(config.DATABASE_URL)

  const sweep = await runLifecycleSweep(db)
  const feed = await emitFeedNotifications(db, sweep.transitions)
  const queue = await reconcileNotifications(db)
  const escalated = await escalateStaleNotifications(db)

  console.log(`\nEvaluated ${sweep.evaluated} merchant(s).`)
  if (sweep.transitions.length === 0) {
    console.log('No lifecycle changes.')
  } else {
    console.log(`${sweep.transitions.length} transition(s):`)
    for (const t of sweep.transitions) {
      console.log(`  ${t.merchantId.slice(0, 8)}  ${t.from ?? '(new)'} → ${t.to}`)
    }
  }
  console.log(
    `\nQueue: ${queue.opened} opened, ${queue.resolved} resolved. ` +
      `Feed: ${feed}. Escalated: ${escalated}.\n`,
  )

  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
