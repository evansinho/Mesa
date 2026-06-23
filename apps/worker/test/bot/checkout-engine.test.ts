import { CheckoutEngine } from '../../src/bot/checkout-engine'
import type { BotRuntimeContext, ProductRow } from '../../src/bot/types'

function product(overrides: Partial<ProductRow> & { id: string; name: string; price: string }): ProductRow {
  return {
    merchantId: 'merchant-1',
    description: null,
    lastPrice: null,
    stockQuantity: 100,
    lowStockThreshold: 5,
    unit: 'unit',
    sku: null,
    aliases: [],
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProductRow
}

function runtime(overrides: Partial<BotRuntimeContext> = {}): BotRuntimeContext {
  return {
    checkoutStage: 'idle',
    cart: [],
    recentMessages: [],
    recentIntentTypes: [],
    ...overrides,
  }
}

describe('CheckoutEngine', () => {
  it('lists category options without totaling all candidates', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime(),
      intent: { type: 'catalog_question', category: 'shoes' },
      catalog: [
        product({ id: 'p1', name: 'Canvas Sneakers', aliases: ['shoes'], price: '25000' }),
        product({ id: 'p2', name: 'Slide Sandals', aliases: ['shoes', 'slides'], price: '8000' }),
      ],
      messageId: 'msg-1',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toContain('shoes options:')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').not.toContain('₦33,000')
  })

  it('clamps proportional negotiation to item floors', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({
        checkoutStage: 'cart_review',
        cart: [
          { key: 'product:p1', productId: 'p1', productName: 'Linen Shirt', quantity: 1, unitPrice: 10000, floorUnitPrice: 9000 },
          { key: 'product:p2', productId: 'p2', productName: 'Denim Jeans', quantity: 1, unitPrice: 21000, floorUnitPrice: 18000 },
        ],
      }),
      intent: { type: 'price_negotiation', offeredTotal: 20000 },
      catalog: [],
      messageId: 'msg-2',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toBe('The best I can do is ₦27,000 for everything.')
    const cart = decision.contextPatch?.botRuntime?.cart ?? []
    expect(cart.map(item => item.negotiatedUnitPrice)).toEqual([9000, 18000])
  })

  it('answers resolved product price questions without merchant escalation', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({ checkoutStage: 'product_selection' }),
      intent: { type: 'product_price_question', items: [{ name: 'senator shirt', quantity: 1 }] },
      catalog: [
        product({ id: 'p1', name: 'Linen Senator Shirt', aliases: ['senator shirt', 'senator'], price: '20000' }),
      ],
      messageId: 'msg-price-1',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toBe('Linen Senator Shirt is ₦20,000. Would you like to order it?')
    expect(decision.contextPatch?.botRuntime?.checkoutStage).toBe('product_selection')
    expect(decision.contextPatch?.botRuntime?.cart.map(item => item.productName)).toEqual(['Linen Senator Shirt'])
    expect(decision.contextPatch?.botRuntime?.activeItemKey).toBe('product:p1')
  })

  it('regresses cart corrections from review to product selection', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({
        checkoutStage: 'cart_review',
        cart: [
          { key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 },
          { key: 'product:p2', productId: 'p2', productName: 'Slim Fit Chinos', quantity: 1, unitPrice: 16000 },
        ],
      }),
      intent: { type: 'cart_correction', remove: ['slides'] },
      catalog: [],
      messageId: 'msg-3',
    })

    expect(decision.contextPatch?.botRuntime?.checkoutStage).toBe('product_selection')
    expect(decision.contextPatch?.botRuntime?.cart.map(item => item.productName)).toEqual(['Slim Fit Chinos'])
  })

  it('creates an order decision only from cart_review confirmation', () => {
    const engine = new CheckoutEngine()
    const notReady = engine.decide({
      runtime: runtime({
        checkoutStage: 'product_selection',
        cart: [{ key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 }],
      }),
      intent: { type: 'cart_confirmation' },
      catalog: [],
      messageId: 'msg-4',
    })
    expect(notReady.type).toBe('SEND_CUSTOMER_REPLY')

    const ready = engine.decide({
      runtime: runtime({
        checkoutStage: 'cart_review',
        cart: [{ key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 }],
      }),
      intent: { type: 'cart_confirmation' },
      catalog: [],
      messageId: 'msg-5',
    })
    expect(ready.type).toBe('CREATE_ORDER')
    expect(ready.type === 'CREATE_ORDER' ? ready.customerReply : '').toBeTruthy()
  })

  it('applies quantity-only updates to the active item even with multiple cart items', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({
        checkoutStage: 'product_selection',
        activeItemKey: 'product:p2',
        cart: [
          { key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 },
          { key: 'product:p2', productId: 'p2', productName: 'Slim Fit Chinos', quantity: 1, unitPrice: 16000 },
        ],
      }),
      intent: { type: 'quantity_update', quantity: 3 },
      catalog: [],
      messageId: 'msg-6',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.contextPatch?.botRuntime?.cart.map(item => [item.productName, item.quantity])).toEqual([
      ['Slide Sandals', 1],
      ['Slim Fit Chinos', 3],
    ])
    expect(decision.contextPatch?.botRuntime?.checkoutStage).toBe('cart_review')
  })

  it('does not request payment before cart review confirmation', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({
        checkoutStage: 'product_selection',
        cart: [{ key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 }],
      }),
      intent: { type: 'payment_request' },
      catalog: [],
      messageId: 'msg-7',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toBe('I need to confirm your cart before payment.')
  })

  it('stores last-price negotiation on the cart before confirmation', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({
        checkoutStage: 'cart_review',
        cart: [{ key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000, floorUnitPrice: 7000 }],
      }),
      intent: { type: 'price_negotiation', asksLastPrice: true },
      catalog: [],
      messageId: 'msg-8',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toBe('₦7,000 is the best I can do.')
    expect(decision.contextPatch?.botRuntime?.cart[0].negotiatedUnitPrice).toBe(7000)
    expect(decision.contextPatch?.lastQuotedPrice).toBe(7000)
  })

  it('starts payment review only when a pending payment order exists', () => {
    const engine = new CheckoutEngine()
    const ready = engine.decide({
      runtime: runtime({
        checkoutStage: 'payment_pending',
        orderId: 'order-1',
        cart: [{ key: 'product:p1', productId: 'p1', productName: 'Slide Sandals', quantity: 1, unitPrice: 8000 }],
      }),
      intent: { type: 'payment_claim', proofHashOrDone: 'done' },
      catalog: [],
      messageId: 'msg-9',
    })

    expect(ready.type).toBe('START_PAYMENT_REVIEW')
    expect(ready.type === 'START_PAYMENT_REVIEW' ? ready.orderId : '').toBe('order-1')
    expect(ready.contextPatch?.botRuntime?.checkoutStage).toBe('payment_review')

    const notReady = engine.decide({
      runtime: runtime({ checkoutStage: 'cart_review' }),
      intent: { type: 'payment_claim', proofHashOrDone: 'done' },
      catalog: [],
      messageId: 'msg-10',
    })
    expect(notReady.type).toBe('NOOP')
  })

  it('answers safe smalltalk without AI-owned side effects', () => {
    const engine = new CheckoutEngine()
    const decision = engine.decide({
      runtime: runtime({ checkoutStage: 'product_selection' }),
      intent: { type: 'smalltalk_or_faq', question: 'thanks' },
      catalog: [],
      messageId: 'msg-11',
    })

    expect(decision.type).toBe('SEND_CUSTOMER_REPLY')
    expect(decision.type === 'SEND_CUSTOMER_REPLY' ? decision.message : '').toBe('You are welcome. What would you like to order?')
  })
})
