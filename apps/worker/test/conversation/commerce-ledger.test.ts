import {
  applyMerchantAcceptanceToLedger,
  applyNlpToLedger,
  applyCheapTextToLedger,
  applyMerchantQuoteToLedger,
  applyValidatedLedgerPatch,
  contextWithLedger,
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
  {
    id: 'prod_sneakers',
    name: 'Sneakers',
    aliases: ['sneakers', 'sneaker'],
    unit: 'pair',
    price: '22000',
    lastPrice: '22000',
    stockQuantity: 8,
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

  it('removes an item and moves active focus to the remaining item', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [
        { productName: 'body cream', quantity: 1 },
        { productName: 'black soap', quantity: 1 },
      ],
    }, catalog)
    expect(ledger.activeItemKey).toBe('black soap')

    ledger = applyValidatedLedgerPatch(ledger, {
      items: [{ operation: 'remove', productName: 'black soap' }],
      signals: { correction: true },
    }, catalog)

    expect(ledger.items.find(item => item.key === 'black soap')?.status).toBe('removed')
    expect(ledger.activeItemKey).toBe('body cream')
  })

  it('supports product replacement corrections', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 2 }],
    }, catalog)

    ledger = applyValidatedLedgerPatch(ledger, {
      items: [
        { operation: 'remove', productName: 'rice' },
        { operation: 'add', productName: 'garri', quantity: 2 },
      ],
      signals: { correction: true, purchaseIntent: true },
    }, catalog)

    expect(ledger.items.find(item => item.key === 'rice')?.status).toBe('removed')
    expect(ledger.items.find(item => item.key === 'garri')).toMatchObject({
      productId: 'prod_garri',
      quantity: 2,
      quotedUnitPrice: 3000,
    })
    expect(ledger.activeItemKey).toBe('garri')
  })

  it('applies cheap product replacement corrections when catalog is available', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 1 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'not rice, garri', catalog)

    expect(ledger?.items.find(item => item.key === 'rice')?.status).toBe('removed')
    expect(ledger?.items.find(item => item.key === 'garri')).toMatchObject({
      productId: 'prod_garri',
      productName: 'Garri',
      quotedUnitPrice: 3000,
    })
    expect(ledger?.activeItemKey).toBe('garri')
  })

  it('applies cheap item removal corrections and re-quotes remaining items', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [
        { productName: 'rice', quantity: 2 },
        { productName: 'garri', quantity: 1 },
      ],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'remove rice', catalog)
    const readiness = evaluateDraftReadiness(ledger!, catalog)
    const action = decideNextAction(ledger!, readiness)

    expect(ledger?.items.find(item => item.key === 'rice')?.status).toBe('removed')
    expect(ledger?.activeItemKey).toBe('garri')
    expect(action).toEqual({
      type: 'REPLY_WITH_PRICE',
      items: [expect.objectContaining({ productName: 'Garri' })],
      total: 3000,
    })
  })

  it('removes catalog items by partial product name and excludes them from mirrored totals', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [
        { productName: 'Plain White Polo Shirt', quantity: 1 },
        { productName: 'Sneakers', quantity: 1 },
      ],
    }, [
      ...catalog,
      {
        id: 'prod_polo',
        name: 'Plain White Polo Shirt',
        aliases: ['polo', 'shirt'],
        unit: 'piece',
        price: '8500',
        lastPrice: '8500',
        stockQuantity: 5,
        active: true,
      },
    ])

    const ledger = applyCheapTextToLedger(base, 'remove polo', catalog)!
    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)
    const mirrored = contextWithLedger({
      currentItems: [],
      negotiationHistory: [],
      lastQuotedPrice: 30500,
      lastMessageAt: '2026-06-20T00:00:00.000Z',
    }, ledger)

    expect(ledger.items.find(item => item.productName === 'Plain White Polo Shirt')?.status).toBe('removed')
    expect(mirrored.currentItems).toHaveLength(1)
    expect(mirrored.currentItems[0]).toMatchObject({ productName: 'Sneakers', unitPrice: 22000 })
    expect(mirrored.lastQuotedPrice).toBe(22000)
    expect(action).toEqual({
      type: 'REPLY_WITH_PRICE',
      items: [expect.objectContaining({ productName: 'Sneakers' })],
      total: 22000,
    })
  })

  it('acknowledges removal when no order items remain', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'rice', quantity: 1 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'remove rice', catalog)
    const readiness = evaluateDraftReadiness(ledger!, catalog)

    expect(ledger?.items.find(item => item.key === 'rice')?.status).toBe('removed')
    expect(decideNextAction(ledger!, readiness)).toEqual({ type: 'ACKNOWLEDGE_CORRECTION' })
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

  it('persists AI-extracted customer, payment, and escalation facts', () => {
    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'PAYMENT_INTENT',
      items: [{ productName: 'body cream', quantity: 1 }],
      facts: {
        customerName: 'Ada',
        deliveryAddress: '12 Allen Avenue Ikeja',
        paymentReference: 'TRF12345',
      },
      signals: {
        asksDelivery: true,
        paymentIntent: true,
        complaint: true,
      },
    }, catalog)
    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(ledger.customer).toMatchObject({
      name: 'Ada',
      deliveryAddress: '12 Allen Avenue Ikeja',
    })
    expect(ledger.payment.reference).toBe('TRF12345')
    expect(ledger.signals.asksDelivery).toBe(true)
    expect(action).toEqual({ type: 'ESCALATE_TO_MERCHANT', reason: 'complaint' })
  })

  it('asks for delivery address when delivery is requested without an address', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 1 }],
      signals: { asksDelivery: true },
    }, catalog)
    ledger = applyValidatedLedgerPatch(ledger, {
      signals: { asksDelivery: true },
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    expect(decideNextAction(ledger, readiness)).toEqual({ type: 'ASK_DELIVERY_ADDRESS' })
  })

  it('acknowledges delivery address when address is provided', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'deliver to 12 allen avenue ikeja', catalog)
    const readiness = evaluateDraftReadiness(ledger!, catalog)

    expect(ledger?.customer.deliveryAddress).toBe('12 allen avenue ikeja')
    expect(ledger?.signals.asksDelivery).toBe(true)
    expect(decideNextAction(ledger!, readiness)).toEqual({
      type: 'ACKNOWLEDGE_DELIVERY_ADDRESS',
      address: '12 allen avenue ikeja',
    })
  })

  it('replies with price for resolved product inquiries without purchase signal', () => {
    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(false)
    if (!readiness.ready) expect(readiness.blockingReason).toBe('missing_purchase_signal')
    expect(action).toEqual({
      type: 'REPLY_WITH_PRICE',
      items: expect.any(Array),
      total: 5000,
    })
  })

  it('returns a total customer offer for negotiation actions', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 3 }],
    }, catalog)
    ledger = applyNlpToLedger(ledger, {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 12000,
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(true)
    expect(action).toEqual({
      type: 'NEGOTIATE',
      quotedTotal: 15000,
      floorTotal: 13500,
      customerOffer: 12000,
    })
  })

  it('clears last-price negotiation when a customer adds a new product', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    ledger = applyCheapTextToLedger(ledger, 'last price', catalog)!
    let readiness = evaluateDraftReadiness(ledger, catalog)
    expect(decideNextAction(ledger, readiness)).toEqual({
      type: 'REPLY_WITH_LAST_PRICE',
      total: 4500,
    })

    ledger = applyNlpToLedger(ledger, {
      intent: 'ORDER',
      items: [{ productName: 'sneakers', quantity: 1 }],
    }, catalog)
    readiness = evaluateDraftReadiness(ledger, catalog)

    expect(ledger.signals.asksLastPrice).toBe(false)
    expect(ledger.signals.negotiation).toBe(false)
    expect(decideNextAction(ledger, readiness)).toEqual({
      type: 'REPLY_WITH_PRICE',
      items: expect.arrayContaining([
        expect.objectContaining({ productName: 'Body Cream' }),
        expect.objectContaining({ productName: 'Sneakers' }),
      ]),
      total: 27000,
    })
  })

  it('clears stale last-price negotiation on broad itemless order turns', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    ledger = applyCheapTextToLedger(ledger, 'last price', catalog)!

    ledger = applyNlpToLedger(ledger, {
      intent: 'ORDER',
      items: [],
    }, catalog)

    expect(ledger.signals.asksLastPrice).toBe(false)
    expect(ledger.signals.negotiation).toBe(false)
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

    ledger = {
      ...ledger,
      draftOrder: { status: 'merchant_confirmed', orderId: 'order_1', total: 5000 },
    }
    expect(deriveConversationState(ledger)).toBe('ORDER_CREATED')

    ledger = {
      ...ledger,
      payment: { status: 'requested' },
    }
    expect(deriveConversationState(ledger)).toBe('AWAITING_PAYMENT')

    ledger = {
      ...ledger,
      payment: { status: 'proof_received', proofUrl: 'https://example.com/proof.png' },
    }
    expect(deriveConversationState(ledger)).toBe('AWAITING_PAYMENT')

    ledger = {
      ...ledger,
      payment: { status: 'verified' },
    }
    expect(deriveConversationState(ledger)).toBe('PAYMENT_RECEIVED')
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

  it('uses the containing context timestamp when normalizing an existing ledger', () => {
    const existing = normalizeLedger({
      currentItems: [{ productName: 'Rice', quantity: 1, unitPrice: 5000 }],
      negotiationHistory: [],
      lastMessageAt: '2026-06-20T00:00:00.000Z',
    }, '+234801')

    const refreshed = normalizeLedger({
      currentItems: [{ productName: 'Rice', quantity: 1, unitPrice: 5000 }],
      negotiationHistory: [],
      ledger: existing,
      lastMessageAt: '2026-06-20T01:00:00.000Z',
    }, '+234801')

    expect(refreshed.lastMessageAt).toBe('2026-06-20T01:00:00.000Z')
  })

  it('overlays legacy item updates onto an existing ledger without losing signals', () => {
    const existing = applyCheapTextToLedger(
      applyNlpToLedger(emptyLedger(), {
        intent: 'ORDER',
        items: [{ productName: 'body cream', quantity: 1 }],
      }, catalog),
      'send aza',
    )!

    const refreshed = normalizeLedger({
      currentItems: [{ productName: 'Body Cream', quantity: 4, unitPrice: 5000, agreedPrice: 18000 }],
      negotiationHistory: [],
      agreedPrice: 18000,
      ledger: existing,
      lastMessageAt: '2026-06-20T01:00:00.000Z',
    }, '+234801')

    expect(refreshed.signals.asksForAccount).toBe(true)
    expect(refreshed.items).toHaveLength(1)
    expect(refreshed.items[0]).toMatchObject({
      productName: 'Body Cream',
      quantity: 4,
      quotedUnitPrice: 5000,
      agreedUnitPrice: 4500,
      status: 'agreed',
    })
  })

  it('reflects legacy item clears into an existing ledger', () => {
    const existing = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    const refreshed = normalizeLedger({
      currentItems: [],
      negotiationHistory: [],
      ledger: existing,
      lastMessageAt: '2026-06-20T01:00:00.000Z',
    }, '+234801')

    expect(refreshed.items).toEqual([])
    expect(refreshed.activeItemKey).toBeUndefined()
  })

  it('preserves runtime catalog fields when mirroring ledger back to legacy context', () => {
    const legacyContext = {
      currentItems: [{
        productId: 'prod_rice',
        productName: 'Rice',
        quantity: 2,
        unitPrice: 5000,
        floorUnitPrice: 4500,
      }],
      negotiationHistory: [],
      lastQuotedPrice: 10000,
      lastMessageAt: '2026-06-20T00:00:00.000Z',
    }

    const ledger = normalizeLedger(legacyContext, '+234801')
    const mirrored = contextWithLedger(legacyContext, ledger)
    const item = mirrored.currentItems[0] as typeof legacyContext.currentItems[number]

    expect(ledger.items[0]).toMatchObject({
      productId: 'prod_rice',
      floorUnitPrice: 4500,
    })
    expect(item.productId).toBe('prod_rice')
    expect(item.floorUnitPrice).toBe(4500)
  })

  it('routes simple low-risk messages without expensive analysis', () => {
    expect(routeMessageForCost('hello', emptyLedger())).toBe('NO_AI')

    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    expect(routeMessageForCost('send aza', ledger)).toBe('CHEAP_RULES')
    expect(routeMessageForCost('deliver to 12 Allen Avenue Ikeja', ledger)).toBe('CHEAP_RULES')
    expect(routeMessageForCost('not body cream, black soap', ledger)).toBe('CATALOG_RULES')
    expect(routeMessageForCost('remove body cream', ledger)).toBe('CATALOG_RULES')
    expect(routeMessageForCost('refund please', ledger)).toBe('SONNET_ESCALATION')
  })

  it('escalates cheap complaint messages through the ledger reducer', () => {
    const ledger = applyCheapTextToLedger(emptyLedger(), 'refund please')
    expect(ledger?.signals.complaint).toBe(true)

    const readiness = evaluateDraftReadiness(ledger!, catalog)
    expect(decideNextAction(ledger!, readiness)).toEqual({
      type: 'ESCALATE_TO_MERCHANT',
      reason: 'complaint',
    })
  })

  it('applies cheap quantity messages through the ledger reducer', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'make am 4')

    expect(ledger).not.toBeNull()
    expect(ledger?.items.find(item => item.key === 'body cream')?.quantity).toBe(4)
    expect(ledger?.signals.purchaseIntent).toBe(true)
  })

  it('applies cheap account requests as payment-ready agreement signals', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 2 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'send aza')
    const readiness = evaluateDraftReadiness(ledger!, catalog)
    const action = decideNextAction(ledger!, readiness)

    expect(ledger?.signals.asksForAccount).toBe(true)
    expect(action.type).toBe('REQUEST_PAYMENT')
  })

  it('applies cheap confirmations as order-summary actions', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      items: [{ productName: 'body cream', quantity: 2 }],
    }, catalog)

    const ledger = applyCheapTextToLedger(base, 'confirm')
    const readiness = evaluateDraftReadiness(ledger!, catalog)
    const action = decideNextAction(ledger!, readiness)

    expect(ledger?.signals.agreement).toBe(true)
    expect(action.type).toBe('SEND_ORDER_SUMMARY')
  })

  it('applies merchant quotes to the active item', () => {
    const base = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 2 }],
    }, catalog)

    const ledger = applyMerchantQuoteToLedger(base, 9000)

    expect(ledger.activeItemKey).toBe('body cream')
    expect(ledger.items[0]).toMatchObject({
      productName: 'Body Cream',
      quantity: 2,
      quotedUnitPrice: 4500,
      status: 'quoted',
    })
  })

  it('enriches existing unresolved ledger items from catalog on later turns', () => {
    const base = normalizeLedger({
      currentItems: [{ productName: 'body cream', quantity: 2 }],
      negotiationHistory: [],
      lastMessageAt: '2026-06-20T00:00:00.000Z',
    }, '+234801')

    const ledger = applyNlpToLedger(base, {
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
    }, catalog)
    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(ledger.items[0]).toMatchObject({
      productId: 'prod_body_cream',
      productName: 'Body Cream',
      quotedUnitPrice: 5000,
      floorUnitPrice: 4500,
    })
    expect(readiness.ready).toBe(true)
    expect(action.type).toBe('SEND_ORDER_SUMMARY')
  })

  it('sends an order summary when a single NLP turn has order facts and agreement', () => {
    const ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'ORDER',
      agreementSignalDetected: true,
      items: [{ productName: 'body cream', quantity: 2 }],
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    const action = decideNextAction(ledger, readiness)

    expect(readiness.ready).toBe(true)
    expect(action.type).toBe('SEND_ORDER_SUMMARY')
  })
})

describe('rejected counter-offer vs merchant re-quote (Sino sneakers regression)', () => {
  // Transcript: customer "how much" → merchant "120k" → customer "na 80k I get"
  // → merchant "last price na 100k" → customer "alright I will take it".
  // The agreed total must be the merchant's last quote (100k), never the
  // customer's rejected offer (80k).
  it('the merchant last quote wins when the customer agrees after a counter', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'sneakers', quantity: 1 }],
    }, catalog)

    ledger = applyMerchantQuoteToLedger(ledger, 120_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 80_000,
    }, catalog)
    ledger = applyMerchantQuoteToLedger(ledger, 100_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    expect(readiness.ready).toBe(true)
    if (!readiness.ready) return
    expect(readiness.draft.total).toBe(100_000)

    const action = decideNextAction(ledger, readiness)
    expect(action.type).toBe('SEND_ORDER_SUMMARY')
    if (action.type === 'SEND_ORDER_SUMMARY') {
      expect(action.draft.total).toBe(100_000)
    }
  })

  it('a pending offer never leaks into context totals', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'sneakers', quantity: 1 }],
    }, catalog)
    ledger = applyMerchantQuoteToLedger(ledger, 120_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 80_000,
    }, catalog)

    const context = contextWithLedger({
      currentItems: [],
      negotiationHistory: [],
      recentMessages: [],
    } as never, ledger)

    // Offer is pending (status 'negotiating') — quoted price stays authoritative.
    expect(context.lastQuotedPrice).toBe(120_000)
    expect(context.currentItems[0]?.agreedPrice).toBeUndefined()
  })

  it('the customer offer stands when the merchant accepts it as their quote', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'sneakers', quantity: 1 }],
    }, catalog)
    ledger = applyMerchantQuoteToLedger(ledger, 120_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 80_000,
    }, catalog)
    // Merchant accepts by quoting the offered amount ("okay 80k")
    ledger = applyMerchantQuoteToLedger(ledger, 80_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
    }, catalog)

    const readiness = evaluateDraftReadiness(ledger, catalog)
    expect(readiness.ready).toBe(true)
    if (readiness.ready) expect(readiness.draft.total).toBe(80_000)
  })
})

describe('merchant accepts a pending offer without repeating the number', () => {
  it('promotes the customer offer to the quoted price ("make I just leave am for you")', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    ledger = applyMerchantQuoteToLedger(ledger, 25_000)
    ledger = applyNlpToLedger(ledger, {
      intent: 'COUNTER_OFFER',
      items: [],
      counterOfferPrice: 20_000,
    }, catalog)

    const accepted = applyMerchantAcceptanceToLedger(ledger)
    expect(accepted).not.toBeNull()
    expect(accepted!.items[0]).toMatchObject({ quotedUnitPrice: 20_000, status: 'quoted' })

    const agreed = applyNlpToLedger(accepted!, {
      intent: 'AGREEMENT',
      items: [],
      agreementSignalDetected: true,
    }, catalog)
    const readiness = evaluateDraftReadiness(agreed, catalog)
    expect(readiness.ready).toBe(true)
    if (readiness.ready) expect(readiness.draft.total).toBe(20_000)
  })

  it('returns null when there is no pending offer', () => {
    let ledger = applyNlpToLedger(emptyLedger(), {
      intent: 'INQUIRY',
      items: [{ productName: 'body cream', quantity: 1 }],
    }, catalog)
    ledger = applyMerchantQuoteToLedger(ledger, 25_000)
    expect(applyMerchantAcceptanceToLedger(ledger)).toBeNull()
  })
})
