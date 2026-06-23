import {
  applyCustomerCommerceTextToLedger,
  applyMerchantCommerceTextToLedger,
  decideNextAction,
  emptyLedger,
  evaluateDraftReadiness,
} from '../../src/conversation/commerce-ledger'
import type { CatalogProduct } from '../../src/conversation/commerce-ledger'

type Turn = { speaker: 'customer' | 'merchant'; text: string }

type Expected = {
  products?: string[]
  quantity?: Record<string, number>
  quotedPrice?: Record<string, number>
  agreedTotal?: number
  readyForPayment?: boolean
  paymentStatus?: 'proof_received' | 'verified'
  deliveryArea?: string
}

type Scenario = {
  scenario: string
  conversation: Turn[]
  expected: Expected
}

const scenarios: Scenario[] = [
  {
    scenario: 'market_price_inquiry',
    conversation: [
      { speaker: 'customer', text: 'Aunty good morning, how much your beans be?' },
      { speaker: 'merchant', text: 'Morning dear, beans is 92k per bag.' },
      { speaker: 'customer', text: 'Chai. If I take 2, fit do better price?' },
      { speaker: 'merchant', text: 'I can do 180k for 2.' },
      { speaker: 'customer', text: 'Okay send account, I dey come.' },
    ],
    expected: {
      products: ['beans'],
      quantity: { beans: 2 },
      quotedPrice: { beans: 92000 },
      agreedTotal: 180000,
      readyForPayment: true,
    },
  },
  {
    scenario: 'fashion_negotiation',
    conversation: [
      { speaker: 'customer', text: 'Sis that gown still dey?' },
      { speaker: 'merchant', text: 'Yes dear, one left.' },
      { speaker: 'customer', text: 'How much?' },
      { speaker: 'merchant', text: '24k.' },
      { speaker: 'customer', text: 'Ah abeg 20k make I carry am.' },
      { speaker: 'merchant', text: 'Okay 22k final.' },
      { speaker: 'customer', text: 'Done, send details.' },
    ],
    expected: {
      products: ['gown'],
      quantity: { gown: 1 },
      quotedPrice: { gown: 24000 },
      agreedTotal: 22000,
      readyForPayment: true,
    },
  },
  {
    scenario: 'phone_accessory_sale',
    conversation: [
      { speaker: 'customer', text: 'Bros do you have iPhone charger?' },
      { speaker: 'merchant', text: 'Yes, type C and iPhone cable dey.' },
      { speaker: 'customer', text: 'I need 2 cables and one head.' },
      { speaker: 'merchant', text: 'Cable is 7k, head is 9k.' },
      { speaker: 'customer', text: 'Okay send account.' },
    ],
    expected: {
      products: ['iPhone cable', 'charger head'],
      quantity: { 'iPhone cable': 2, 'charger head': 1 },
      quotedPrice: { 'iPhone cable': 7000, 'charger head': 9000 },
      readyForPayment: true,
    },
  },
  {
    scenario: 'garri_and_oil_order',
    conversation: [
      { speaker: 'customer', text: 'Aunty, how much garri and palm oil be?' },
      { speaker: 'merchant', text: 'Garri na 18k per bag, oil na 14k per keg.' },
      { speaker: 'customer', text: 'If I take 2 garri and 1 oil, you fit reduce am small?' },
      { speaker: 'merchant', text: 'I fit do 48k for everything.' },
      { speaker: 'customer', text: 'Okay send account make I pay.' },
    ],
    expected: {
      products: ['garri', 'palm oil'],
      quantity: { garri: 2, 'palm oil': 1 },
      quotedPrice: { garri: 18000, 'palm oil': 14000 },
      agreedTotal: 48000,
      readyForPayment: true,
    },
  },
  {
    scenario: 'small_provision_store',
    conversation: [
      { speaker: 'customer', text: 'Good evening, any sardine and tea?' },
      { speaker: 'merchant', text: 'Yes, sardine 1,500 and tea 2,000.' },
      { speaker: 'customer', text: 'Give me 5 sardine and 3 tea.' },
      { speaker: 'merchant', text: 'Okay, total na 13,500.' },
      { speaker: 'customer', text: 'I dey send transfer now.' },
    ],
    expected: {
      products: ['sardine', 'tea'],
      quantity: { sardine: 5, tea: 3 },
      agreedTotal: 13500,
      readyForPayment: true,
    },
  },
  {
    scenario: 'fashion_colour_choice',
    conversation: [
      { speaker: 'customer', text: 'You get this shoe for brown?' },
      { speaker: 'merchant', text: 'Yes, brown dey available.' },
      { speaker: 'customer', text: 'Size 42 na.' },
      { speaker: 'merchant', text: 'Okay, 42 brown shoe is 27k.' },
      { speaker: 'customer', text: 'Send account.' },
    ],
    expected: {
      products: ['shoe'],
      quantity: { shoe: 1 },
      quotedPrice: { shoe: 27000 },
      readyForPayment: true,
    },
  },
  {
    scenario: 'market_haggling',
    conversation: [
      { speaker: 'customer', text: 'Aunty, last price for the live chicken?' },
      { speaker: 'merchant', text: 'Live chicken na 14k.' },
      { speaker: 'customer', text: '13k?' },
      { speaker: 'merchant', text: 'Okay 13,500 and come carry am.' },
      { speaker: 'customer', text: 'Alright, I accept.' },
    ],
    expected: {
      products: ['live chicken'],
      quantity: { 'live chicken': 1 },
      quotedPrice: { 'live chicken': 14000 },
      agreedTotal: 13500,
    },
  },
  {
    scenario: 'bulk_price_request',
    conversation: [
      { speaker: 'customer', text: 'If I buy 100 branded cups, how much?' },
      { speaker: 'merchant', text: '100 pieces na 120k.' },
      { speaker: 'customer', text: 'Can you do 110k?' },
      { speaker: 'merchant', text: 'Make we settle for 112k.' },
    ],
    expected: {
      products: ['branded cups'],
      quantity: { 'branded cups': 100 },
      quotedPrice: { 'branded cups': 1200 },
      agreedTotal: 112000,
    },
  },
  {
    scenario: 'fresh_food_market_order',
    conversation: [
      { speaker: 'customer', text: 'Aunty morning, I need fresh pepper and tomato.' },
      { speaker: 'merchant', text: 'Morning dear, pepper na 10k basket, tomato na 22k.' },
      { speaker: 'customer', text: 'I need half basket pepper and one basket tomato.' },
      { speaker: 'merchant', text: 'Okay, total na 27k.' },
      { speaker: 'customer', text: 'Send account abeg.' },
    ],
    expected: {
      products: ['pepper', 'tomato'],
      quantity: { pepper: 0.5, tomato: 1 },
      quotedPrice: { pepper: 10000, tomato: 22000 },
      agreedTotal: 27000,
      readyForPayment: true,
    },
  },
  {
    scenario: 'pharmacy_item_request',
    conversation: [
      { speaker: 'customer', text: 'Bros you get cough syrup?' },
      { speaker: 'merchant', text: 'Yes, we get am.' },
      { speaker: 'customer', text: 'How much?' },
      { speaker: 'merchant', text: '3,500.' },
      { speaker: 'customer', text: 'Okay give me 2.' },
    ],
    expected: {
      products: ['cough syrup'],
      quantity: { 'cough syrup': 2 },
      quotedPrice: { 'cough syrup': 3500 },
    },
  },
  {
    scenario: 'construction_materials',
    conversation: [
      { speaker: 'customer', text: 'Bros cement still dey?' },
      { speaker: 'merchant', text: 'Yes, cement dey.' },
      { speaker: 'customer', text: 'How much one bag?' },
      { speaker: 'merchant', text: '9,200.' },
      { speaker: 'customer', text: 'I need 20 bags, make e reach site tomorrow.' },
    ],
    expected: {
      products: ['cement'],
      quantity: { cement: 20 },
      quotedPrice: { cement: 9200 },
    },
  },
  {
    scenario: 'electronics_inquiry',
    conversation: [
      { speaker: 'customer', text: 'You dey sell fridge?' },
      { speaker: 'merchant', text: 'Yes, double door and single door dey.' },
      { speaker: 'customer', text: 'How much the single door?' },
      { speaker: 'merchant', text: '120k.' },
      { speaker: 'customer', text: 'Any small discount if I pay today?' },
      { speaker: 'merchant', text: 'I fit reduce am small to 115k.' },
    ],
    expected: {
      products: ['fridge'],
      quantity: { fridge: 1 },
      quotedPrice: { fridge: 120000 },
      agreedTotal: 115000,
    },
  },
  {
    scenario: 'payment_screenshot_style',
    conversation: [
      { speaker: 'customer', text: 'I don transfer am, check your side.' },
      { speaker: 'merchant', text: 'Let me confirm.' },
      { speaker: 'customer', text: 'I sent the screenshot too.' },
      { speaker: 'merchant', text: 'Yes, payment don enter.' },
    ],
    expected: {
      paymentStatus: 'verified',
    },
  },
  {
    scenario: 'delivery_and_payment',
    conversation: [
      { speaker: 'customer', text: 'If I pay now, can you bring am to Ikeja?' },
      { speaker: 'merchant', text: 'Yes, delivery is available.' },
      { speaker: 'customer', text: 'How much total with delivery?' },
      { speaker: 'merchant', text: 'It will be 28k all in.' },
      { speaker: 'customer', text: 'Okay send account.' },
    ],
    expected: {
      agreedTotal: 28000,
      readyForPayment: true,
      deliveryArea: 'ikeja',
    },
  },
]

function catalogFor(scenario: Scenario): CatalogProduct[] {
  const productNames = new Set<string>()
  for (const name of scenario.expected.products ?? []) productNames.add(name)
  for (const item of Object.keys(scenario.expected.quantity ?? {})) productNames.add(item)
  for (const item of Object.keys(scenario.expected.quotedPrice ?? {})) productNames.add(item)

  return [...productNames].map(name => ({
    id: `prod_${name.toLowerCase().replace(/\s+/g, '_')}`,
    name,
    aliases: [
      name,
      name.replace(/^iphone /i, ''),
      name.replace(/^charger /i, ''),
      name.replace(/^palm /i, ''),
      name.split(' ').at(-1) ?? name,
    ],
    unit: 'unit',
    price: '0',
    active: true,
  }))
}

function runScenario(scenario: Scenario) {
  const catalog = catalogFor(scenario)
  let ledger = emptyLedger('+2348012345678')
  for (const turn of scenario.conversation) {
    ledger = turn.speaker === 'customer'
      ? applyCustomerCommerceTextToLedger(ledger, turn.text, catalog)
      : applyMerchantCommerceTextToLedger(ledger, turn.text, catalog)
  }
  return { ledger, catalog }
}

describe('commerce transcript eval pack', () => {
  it.each(scenarios)('tracks $scenario', scenario => {
    const { ledger, catalog } = runScenario(scenario)
    const activeItems = ledger.items.filter(item => item.status !== 'removed')

    for (const product of scenario.expected.products ?? []) {
      expect(activeItems.map(item => item.productName.toLowerCase())).toContain(product.toLowerCase())
    }

    for (const [product, quantity] of Object.entries(scenario.expected.quantity ?? {})) {
      const item = activeItems.find(i => i.productName.toLowerCase() === product.toLowerCase())
      expect(item?.quantity).toBe(quantity)
    }

    for (const [product, quoted] of Object.entries(scenario.expected.quotedPrice ?? {})) {
      const item = activeItems.find(i => i.productName.toLowerCase() === product.toLowerCase())
      expect(item?.quotedUnitPrice).toBe(quoted)
    }

    if (scenario.expected.agreedTotal != null) {
      const total = ledger.draftOrder?.total ??
        activeItems.reduce((sum, item) => sum + ((item.agreedUnitPrice ?? item.quotedUnitPrice ?? 0) * (item.quantity ?? 1)), 0)
      expect(Math.round(total)).toBe(scenario.expected.agreedTotal)
    }

    if (scenario.expected.readyForPayment) {
      const readiness = evaluateDraftReadiness(ledger, catalog)
      const action = decideNextAction(ledger, readiness)
      expect(action.type).toBe('REQUEST_PAYMENT')
    }

    if (scenario.expected.paymentStatus) {
      expect(ledger.payment.status).toBe(scenario.expected.paymentStatus)
    }

    if (scenario.expected.deliveryArea) {
      expect(ledger.customer.deliveryPreference).toContain(scenario.expected.deliveryArea)
    }
  })
})
