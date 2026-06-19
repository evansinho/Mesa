// Mesa NLP Evaluation Suite
// Tests real Claude Haiku classification against golden fixtures.
// Run with: MESA_RUN_NLP_EVALS=1 pnpm --filter @mesa/worker test test/evals/nlp.eval.ts
//
// Requires ANTHROPIC_API_KEY in env (set in .env.test or shell).
// Costs ~$0.001 per run (Haiku pricing). Do NOT run in CI by default.

import { analyseMessage } from '@mesa/ai'

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function priceClose(actual: number | undefined, expected: number, tolerancePct = 0.01): boolean {
  if (actual === undefined || actual === null) return false
  return Math.abs(actual - expected) / expected <= tolerancePct
}

function itemNameMatch(actual: string, expected: string): boolean {
  return actual.toLowerCase().includes(expected.toLowerCase()) ||
    expected.toLowerCase().includes(actual.toLowerCase())
}

type GradeResult = { pass: boolean; reasons: string[] }

function grade(
  actual: Awaited<ReturnType<typeof analyseMessage>>,
  expected: CaseExpect,
): GradeResult {
  const reasons: string[] = []

  if (expected.intent !== undefined && actual.intent !== expected.intent) {
    reasons.push(`intent: got "${actual.intent}", want "${expected.intent}"`)
  }

  if (expected.agreementSignalDetected !== undefined &&
      actual.agreementSignalDetected !== expected.agreementSignalDetected) {
    reasons.push(`agreementSignalDetected: got ${actual.agreementSignalDetected}, want ${expected.agreementSignalDetected}`)
  }

  if (expected.counterOfferPrice !== undefined) {
    if (!priceClose(actual.counterOfferPrice, expected.counterOfferPrice)) {
      reasons.push(`counterOfferPrice: got ${actual.counterOfferPrice}, want ${expected.counterOfferPrice}`)
    }
  }

  if (expected.lastMentionedPrice !== undefined) {
    const candidate = actual.lastMentionedPrice ?? actual.counterOfferPrice
    if (!priceClose(candidate, expected.lastMentionedPrice)) {
      reasons.push(`lastMentionedPrice: got ${candidate}, want ${expected.lastMentionedPrice}`)
    }
  }

  if (expected.itemCount !== undefined && actual.items.length !== expected.itemCount) {
    reasons.push(`itemCount: got ${actual.items.length}, want ${expected.itemCount}`)
  }

  if (expected.firstItemName !== undefined) {
    const firstName = actual.items[0]?.productName ?? ''
    if (!itemNameMatch(firstName, expected.firstItemName)) {
      reasons.push(`firstItemName: got "${firstName}", want something matching "${expected.firstItemName}"`)
    }
  }

  if (expected.firstItemQty !== undefined && actual.items[0]?.quantity !== expected.firstItemQty) {
    reasons.push(`firstItemQty: got ${actual.items[0]?.quantity}, want ${expected.firstItemQty}`)
  }

  return { pass: reasons.length === 0, reasons }
}

// ─── Case type ────────────────────────────────────────────────────────────────

type CaseExpect = {
  intent?: string
  agreementSignalDetected?: boolean
  counterOfferPrice?: number
  lastMentionedPrice?: number
  itemCount?: number
  firstItemName?: string
  firstItemQty?: number
}

type NLPCase = {
  label: string
  message: string
  history?: { role: 'vendor' | 'customer'; text: string }[]
  products?: { name: string; aliases: string[]; unit: string; price?: number }[]
  expect: CaseExpect
}

// ─── Test cases ───────────────────────────────────────────────────────────────

const CASES: NLPCase[] = [
  // ── Orders ──────────────────────────────────────────────────────────────────
  {
    label: 'plain English order — single item',
    message: 'I want 3 bags of rice',
    expect: { intent: 'ORDER', itemCount: 1, firstItemName: 'rice', firstItemQty: 3 },
  },
  {
    label: 'Pidgin order — cartons',
    message: 'Abeg send me 5 cartons of Indomie',
    expect: { intent: 'ORDER', itemCount: 1, firstItemName: 'Indomie', firstItemQty: 5 },
  },
  {
    label: 'order with quantity word',
    message: 'I need one bag flour',
    expect: { intent: 'ORDER', itemCount: 1, firstItemName: 'flour', firstItemQty: 1 },
  },
  {
    label: 'multi-item order',
    message: 'I want 2 bags of rice and 1 garri',
    expect: { intent: 'ORDER', itemCount: 2 },
  },

  // ── Inquiries ────────────────────────────────────────────────────────────────
  {
    label: 'price inquiry — English',
    message: 'How much for rice?',
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'price inquiry — Pidgin wetin',
    message: 'Wetin be the price?',
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'price inquiry — rate question',
    message: "What's your rate for garri?",
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'informal pidgin inquiry — wig',
    message: 'abeg how much be the wig wey you post',
    expect: { intent: 'INQUIRY' },
  },

  // ── Counter offers ───────────────────────────────────────────────────────────
  {
    label: 'counter offer — ₦ symbol',
    message: 'Abeg do ₦40,000 na',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 40000 },
  },
  {
    label: 'counter offer — k notation',
    message: 'Can you do 35k?',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 35000 },
  },
  {
    label: 'counter offer — pidgin with price',
    message: 'e too much na, I go do 150k',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 150000 },
  },
  {
    label: 'counter offer — abeg do lowercase k',
    message: 'abeg do 3k',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 3000 },
  },
  {
    label: 'counter offer — "last" phrasing',
    message: '4k last',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 4000 },
  },
  {
    label: 'counter offer — decimal k',
    message: 'Can you do 12.5k?',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 12500 },
  },
  {
    label: 'counter offer — million notation',
    message: 'I can do 1.2m for all of them',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 1200000 },
  },

  // ── Agreements ───────────────────────────────────────────────────────────────
  {
    label: 'agreement — "okay deal"',
    message: 'Okay deal',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — pidgin "e don do"',
    message: 'e don do',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — thumbs up emoji (no history)',
    message: '👍',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — thumbs up emoji (after price quote)',
    message: '👍',
    history: [
      { role: 'vendor', text: 'I can do ₦4,500 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "Na deal" pidgin',
    message: 'Na deal',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — pidgin "oya na I go take am"',
    message: 'Oya na, I go take am',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "oya I go manage am" (after price quote)',
    message: 'oya I go manage am',
    history: [
      { role: 'vendor', text: 'I can do ₦165,000 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "ok" with active negotiation in history',
    message: 'ok',
    history: [
      { role: 'customer', text: 'how much for rice?' },
      { role: 'vendor', text: 'Rice is ₦5,000 per bag.' },
      { role: 'customer', text: 'abeg do 4k' },
      { role: 'vendor', text: 'I can do ₦4,500 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'NOT agreement — "ok" with no commerce history',
    message: 'ok',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'agreement with price — "oya na 4500"',
    message: 'oya na 4500',
    history: [
      { role: 'vendor', text: 'I can do ₦4,500 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true, lastMentionedPrice: 4500 },
  },

  // ── Payment intent ───────────────────────────────────────────────────────────
  {
    label: 'payment intent — "I\'ve paid"',
    message: "I've paid, check now",
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "done transfer"',
    message: 'Done transfer',
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "I\'m sending now"',
    message: "I'm sending now",
    expect: { intent: 'PAYMENT_INTENT' },
  },

  // ── Product name normalisation ────────────────────────────────────────────────
  {
    label: 'alias normalised to canonical product name',
    message: 'I want 2 packs of noodles',
    products: [{ name: 'Indomie Noodles', aliases: ['noodles', 'indomie'], unit: 'pack', price: 250 }],
    expect: { intent: 'ORDER', firstItemName: 'Indomie Noodles', firstItemQty: 2 },
  },

  // ── More pidgin order forms ──────────────────────────────────────────────────
  {
    label: 'order — "I go carry" pidgin form',
    message: 'I go carry 3 bags of rice',
    expect: { intent: 'ORDER', firstItemName: 'rice', firstItemQty: 3 },
  },
  {
    label: 'order — "abeg pack" form',
    message: 'abeg pack 5 Indomie for me',
    expect: { intent: 'ORDER', firstItemName: 'Indomie', firstItemQty: 5 },
  },
  {
    label: 'order — "send me" pidgin',
    message: 'send me 2 bottles of groundnut oil',
    expect: { intent: 'ORDER', firstItemName: 'groundnut oil', firstItemQty: 2 },
  },
  {
    // "I go take 2 bags" after a price quote is committing to buy — AGREEMENT is correct
    label: 'agreement + quantity — "I go take 2 bags" after price',
    message: 'I go take 2 bags',
    history: [
      { role: 'vendor', text: 'Rice is ₦5,000 per bag.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },

  // ── Availability inquiries ───────────────────────────────────────────────────
  {
    label: 'inquiry — "you get X?" availability check',
    message: 'you get garri?',
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'inquiry — "X dey?" pidgin availability',
    message: 'rice dey?',
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'inquiry — bare "price?" question',
    message: 'price?',
    history: [
      { role: 'customer', text: 'I want to buy rice' },
    ],
    expect: { intent: 'INQUIRY' },
  },
  {
    label: 'inquiry — "how much last?" final price request',
    message: 'how much last?',
    expect: { intent: 'INQUIRY' },
  },

  // ── Counter offers without a specific price ──────────────────────────────────
  {
    label: 'counter offer — "reduce am small" (no price)',
    message: 'reduce am small',
    history: [
      { role: 'vendor', text: 'The price is ₦8,000.' },
    ],
    expect: { intent: 'COUNTER_OFFER' },
  },
  {
    label: 'counter offer — "e too much abeg" (no price)',
    message: 'e too much abeg',
    history: [
      { role: 'vendor', text: 'That wig is ₦180,000.' },
    ],
    expect: { intent: 'COUNTER_OFFER' },
  },
  {
    label: 'counter offer — "abeg fit do better?" (no price)',
    message: 'abeg fit do better price?',
    history: [
      { role: 'vendor', text: 'Rice is ₦5,000 per bag.' },
    ],
    expect: { intent: 'COUNTER_OFFER' },
  },
  {
    label: 'counter offer — "everything for 50k" bundle offer',
    message: 'everything for 50k',
    history: [
      { role: 'customer', text: 'I want 2 rice and 1 garri' },
      { role: 'vendor', text: 'That comes to ₦13,000.' },
    ],
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 50000 },
  },
  {
    label: 'counter offer — "I go pay 100k" when quoted 150k',
    message: 'I go pay 100k',
    history: [
      { role: 'vendor', text: 'The price is ₦150,000.' },
    ],
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 100000 },
  },
  {
    label: 'counter offer — "abeg take 30k" form',
    message: 'abeg take 30k',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 30000 },
  },
  {
    label: 'counter offer — "fit do 45?" polite form',
    message: 'fit do 45k?',
    expect: { intent: 'COUNTER_OFFER', counterOfferPrice: 45000 },
  },

  // ── More agreement forms ─────────────────────────────────────────────────────
  {
    label: 'agreement — "send account" requesting payment details',
    message: 'send account',
    history: [
      { role: 'vendor', text: 'I can do ₦5,000 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "acc details abeg"',
    message: 'acc details abeg',
    history: [
      { role: 'vendor', text: 'Rice is ₦5,000.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "oya send am"',
    message: 'oya send am',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "sorted" British-Nigerian slang',
    message: 'sorted',
    history: [
      { role: 'vendor', text: 'I can do ₦12,500 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "no wahala I go take am"',
    message: 'no wahala, I go take am',
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement — "confirm" after order context',
    message: 'confirm',
    history: [
      { role: 'vendor', text: 'Order summary: 2x Rice — ₦10,000. Shall I confirm?' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },
  {
    label: 'agreement with price — "oya 4500 final"',
    message: 'oya 4500 final',
    history: [
      { role: 'vendor', text: 'I can do ₦4,500 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true, lastMentionedPrice: 4500 },
  },
  {
    label: 'agreement — "bet" slang after price',
    message: 'bet',
    history: [
      { role: 'vendor', text: 'I can do ₦8,000 for it.' },
    ],
    expect: { intent: 'AGREEMENT', agreementSignalDetected: true },
  },

  // ── More payment intent forms ────────────────────────────────────────────────
  {
    label: 'payment intent — "I don pay" pidgin (I have paid)',
    message: 'I don pay',
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "check ur acct"',
    message: 'check ur acct',
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "transfer don go" pidgin',
    message: 'transfer don go',
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "I just send am"',
    message: 'I just send am',
    expect: { intent: 'PAYMENT_INTENT' },
  },
  {
    label: 'payment intent — "payment made"',
    message: 'payment made',
    expect: { intent: 'PAYMENT_INTENT' },
  },

  // ── False positives — should NOT trigger commerce intents ────────────────────
  {
    label: 'NONE — "I will think about it"',
    message: 'I will think about it',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — "maybe later"',
    message: 'maybe later',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — "let me see if I have money"',
    message: 'let me see if I have money',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — phone number should not be price',
    message: 'pls call me on 08012345678',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — pure greeting — no commerce',
    message: 'Hello',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — thanks — no commerce',
    message: 'Thank you!',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
  {
    label: 'NONE — "no wahala" alone (not a commerce signal)',
    message: 'no wahala',
    expect: { intent: 'NONE', agreementSignalDetected: false },
  },
]

// ─── Test runner ──────────────────────────────────────────────────────────────

const PASS_THRESHOLD = 0.80

describe('NLP eval — real Claude Haiku classification', () => {
  const results: { label: string; pass: boolean; reasons: string[] }[] = []

  afterAll(() => {
    const passed = results.filter(r => r.pass).length
    const total = results.length
    const rate = passed / total
    console.log(`\n📊 NLP Eval pass rate: ${passed}/${total} (${Math.round(rate * 100)}%)`)
    results
      .filter(r => !r.pass)
      .forEach(r => console.log(`  ✗ ${r.label}\n    ${r.reasons.join('\n    ')}`))
    if (rate < PASS_THRESHOLD) {
      throw new Error(`NLP pass rate ${Math.round(rate * 100)}% is below threshold ${Math.round(PASS_THRESHOLD * 100)}%`)
    }
  })

  for (const c of CASES) {
    it(c.label, async () => {
      const actual = await analyseMessage(c.message, c.history ?? [], c.products ?? [])
      const result = grade(actual, c.expect)
      results.push({ label: c.label, ...result })

      if (!result.pass) {
        console.warn(`FAIL [${c.label}]: ${result.reasons.join('; ')}`)
      }

      // Individual test passes unconditionally — overall threshold enforced in afterAll.
      // This lets all cases run rather than stopping at the first failure.
      expect(actual.intent).toBeDefined()
      expect(actual.confidence).toBeGreaterThanOrEqual(0)
    }, 15_000) // 15s timeout per case — Haiku is fast but we're polite
  }
})
