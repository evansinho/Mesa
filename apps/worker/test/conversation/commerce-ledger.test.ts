import {
  applyNlpToLedger,
  applyValidatedLedgerPatch,
  decideNextAction,
  deriveConversationState,
  emptyLedger,
  evaluateDraftReadiness,
  normalizeLedger,
  routeMessageForCost,
} from '../../src/conversation/commerce-ledger'
import type { CatalogProduct } from '../../src/conversation/commerce-ledger'

const catalog: CatalogProduct[] = [
  {
    id: 'prod_body_cream',
    name: 'Body Cream',
    aliases: ['body cream', 'cream'],
    unit: 'piece',
    price: '5000',
    lastPrice: '4500',
    stockQuantity: 10,
    active: true,
  },
  {
    id: 'prod_black_soap',
    name: 'Black Soap',
    aliases: ['black soap', 'soap'],
    unit: 'piece',
    price: '2500',
    lastPrice: '2200',
    stockQuantity: 5,
    active: true,
  },
  {
    id: 'prod_rice',
    name: 'Rice',
    aliases: ['rice'],
    unit: 'bag',
    price: '5000',
    lastPrice: '4500',
    stockQuantity: 20,
    active: true,
  },
  {
    id: 'prod_garri',
    name: 'Garri',
    aliases: ['garri'],
    unit: 'bag',
    price: '3000',
    lastPrice: '2500',
    stockQuantity: 20,
    active: true,
  },
]

describe('commerce ledger reducer', () => {
  it('sets activeItemKey when a product is mentioned', () => {
    const ledger = applyNlpToLedger(emptyLedger('+234801'), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    expect(ledger.activeItemKey).toBe('body cream')
    expect(ledger.items[0]).toMatchObject({
      productId: 'prod_body_cream',
      productName: 'Body Cream',
      quantity: 1,
      quotedUnitPrice: 5000,
      floorUnitPrice: 4500,
      status: 'quoted',
    })
  })

  it('applies a quantity-only message to the active item', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    ledger = applyValidatedLedgerPatch(ledger, {
      items: [{ operation: 'update', quantity: 3 }],
      signals: { purchaseIntent: true },
    }, catalog)

    expect(ledger.items.find(item => item.key === 'body cream')?.quantity).toBe(3)
    expect(ledger.draftOrder?.blockingReason).toBeUndefined()
  })

  it('blocks quantity-only messages when there is no active item', () => {
    const ledger = applyValidatedLedgerPatch(emptyLedger(), {
      items: [{ operation: 'update', quantity: 3 }],
    }, catalog)

    expect(ledger.draftOrder?.blockingReason).toBe('ambiguous_item_reference')
  })

  it('switches active item when a new product is mentioned', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    ledger = applyNlpToLedger(ledger, {
      intent: 'INQUIRY',
      items: [{ productName: 'black soap', quantity: 1 }],
    }, catalog)
    ledger = applyValidatedLedgerPatch(ledger, {
      items: [{ operation: 'update', quantity: 2 }],
      signals: { purchaseIntent: true },
    }, catalog)

    expect(ledger.activeItemKey).toBe('black soap')
    expect(ledger.items.find(item => item.key === 'body cream')?.quantity).toBe(1)
    expect(ledger.items.find(item => item.key === 'black soap')?.quantity).toBe(2)
  })

  it('drafts multi-product orders when all facts and purchase signal exist', () => {
    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [
        { productName: 'rice', quantity: 2 },
        { productName: 'garri', quantity: 1 },
      ],
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    expect(readiness.ready).toBe(true)
    if (readiness.ready) {
      expect(readiness.draft.total).toBe(13000)
    }
  })

  it('asks for quantity before account details when quantity is missing', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 0 }],
    }, catalog)
    ledger = applyValidatedLedgerPatch(ledger, {
      signals: { asksForAccount: true, agreement: true },
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(false)
    if (!readiness.ready) expect(readiness.blockingReason).toBe('missing_quantity')
    expect(action).toEqual({ type: 'ASK_QUANTITY', productName: 'Body Cream' })
  })

  it('requests payment when customer asks for account after complete order facts', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 3 }],
    }, catalog)
    ledger = applyValidatedLedgerPatch(ledger, {
      signals: { asksForAccount: true, agreement: true },
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(true)
    expect(action.type).toBe('REQUEST_PAYMENT')
  })

  it('escalates payment claims without order facts', () => {
    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'PAYMENT_INTENT',
      items: [],
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(false)
    if (!readiness.ready) expect(readiness.blockingReason).toBe('payment_without_order_facts')
    expect(action).toEqual({ type: 'ESCALATE_TO_MERCHANT', reason: 'payment_without_order_facts' })
  })

  it('derives existing conversation states from ledger checkpoints', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    expect(deriveConversationState(ledger)).toBe('NEGOTIATING')

    ledger = {
      ...ledger,
      draftOrder: { status: 'customer_confirmed', total: 5000 },
    }
    expect(deriveConversationState(ledger)).toBe('AGREED')
  })

  it('normalizes legacy context into a ledger', () => {
    const ledger = normalizeLedger({
      currentItems: [{ productName: 'Rice', quantity: 2, unitPrice: 5000 }],
      negotiationHistory: [],
      lastQuotedPrice: 10000,
      lastMessageAt: '2026-06-20T00:00:00.000Z',
    }, '+234801')

    expect(ledger.customer.phone).toBe('+234801')
    expect(ledger.items[0]).toMatchObject({ productName: 'Rice', quantity: 2, status: 'quoted' })
    expect(ledger.activeItemKey).toBe('rice')
  })

  it('routes simple low-risk messages without expensive analysis', () => {
    expect(routeMessageForCost('hello', emptyLedger())).toBe('NO_AI')

    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    expect(routeMessageForCost('send aza', ledger)).toBe('CHEAP_RULES')
    expect(routeMessageForCost('refund please', ledger)).toBe('SONNET_ESCALATION')
  })
})
