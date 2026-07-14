// Mesa's WhatsApp template set — the single source of truth, captured from the
// live approved definitions on the original WABA. Templates exist PER WABA, so
// every merchant connected via embedded signup needs these created on their
// account before any tap/notification template can deliver.

export interface MesaTemplateDefinition {
  name: string
  language: string
  category: 'UTILITY' | 'AUTHENTICATION'
  components: unknown[]
  // Body text with {{n}} placeholders — used to render a plain-text fallback
  // while a freshly provisioned template is still in Meta review.
  bodyText?: string
}

function bodyComponent(text: string, example?: string[]): unknown {
  return {
    type: 'BODY',
    text,
    ...(example ? { example: { body_text: [example] } } : {}),
  }
}

export const MESA_TEMPLATE_DEFINITIONS: MesaTemplateDefinition[] = [
  {
    name: 'mesa_new_order_v2',
    language: 'en',
    category: 'UTILITY',
    bodyText: '📦 New order received.\n\nCustomer: {{1}}\n\n{{2}}\n\nEstimated total: {{3}}\n\nReply or tap:\nACCEPT - confirm this order\nREJECT - cancel it\nOr send the correct total, e.g., 140000\n\nTo change items too, send:\n2x jeans, 1x shirt = 180000\n\nReply LINK for the review page.',
    components: [
      bodyComponent('📦 New order received.\n\nCustomer: {{1}}\n\n{{2}}\n\nEstimated total: {{3}}\n\nReply or tap:\nACCEPT - confirm this order\nREJECT - cancel it\nOr send the correct total, e.g., 140000\n\nTo change items too, send:\n2x jeans, 1x shirt = 180000\n\nReply LINK for the review page.', ['John Doe', '2x Jeans', '₦50,000']),
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Accept' }, { type: 'QUICK_REPLY', text: 'Reject' }] },
    ],
  },
  {
    name: 'mesa_payment_needs_confirmation_v2',
    language: 'en',
    category: 'UTILITY',
    bodyText: '⚠️ Payment needs confirmation\n\nOrder: {{1}}\nCustomer: {{2}}\nExpected: {{3}}\nReceived: {{4}}\nReason: {{5}}\n\nA payment proof was submitted, but Mesa could not fully verify it.\n\nReply or tap:\nCONFIRM - mark payment as paid\nNOT YET - check again later\nDISPUTE - mark for follow-up\nLINK - open review page',
    components: [
      bodyComponent('⚠️ Payment needs confirmation\n\nOrder: {{1}}\nCustomer: {{2}}\nExpected: {{3}}\nReceived: {{4}}\nReason: {{5}}\n\nA payment proof was submitted, but Mesa could not fully verify it.\n\nReply or tap:\nCONFIRM - mark payment as paid\nNOT YET - check again later\nDISPUTE - mark for follow-up\nLINK - open review page', ['ORD-12345678', 'John Doe', '₦25,000', '₦25,000', 'Bank account not connected']),
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'CONFIRM' }, { type: 'QUICK_REPLY', text: 'NOT YET' }, { type: 'QUICK_REPLY', text: 'DISPUTE' }] },
    ],
  },
  {
    name: 'mesa_payment_confirmed',
    language: 'en',
    category: 'UTILITY',
    bodyText: '✅ Payment confirmed.\n\nOrder: {{1}}\nCustomer: {{2}}\n\n{{3}}\n\nTotal paid: {{4}}\n\nHow should this order be fulfilled?\n\nReply or tap:\nBOOK RIDER - collect address and prepare dispatch\nSELF DELIVER - you will handle delivery\nPICKUP - customer will pick up\nLINK - open Mesa',
    components: [
      bodyComponent('✅ Payment confirmed.\n\nOrder: {{1}}\nCustomer: {{2}}\n\n{{3}}\n\nTotal paid: {{4}}\n\nHow should this order be fulfilled?\n\nReply or tap:\nBOOK RIDER - collect address and prepare dispatch\nSELF DELIVER - you will handle delivery\nPICKUP - customer will pick up\nLINK - open Mesa', ['ORD-12345678', 'John(08000000)', '1x blue shirt', '₦15000']),
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Book Rider' }, { type: 'QUICK_REPLY', text: 'Self Deliver' }, { type: 'QUICK_REPLY', text: 'Pickup' }] },
    ],
  },
  {
    name: 'mesa_payment_check_again',
    language: 'en',
    category: 'UTILITY',
    bodyText: '💳 Payment check\n\nOrder: {{1}}\n\nAmount: {{2}}\n\nHas this payment landed in your bank account?',
    components: [
      bodyComponent('💳 Payment check\n\nOrder: {{1}}\n\nAmount: {{2}}\n\nHas this payment landed in your bank account?', ['ORD-12345678', '₦25,000']),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Review', url: 'https://app.getmesa.co/actions/payment/{{1}}', example: ['https://app.getmesa.co/actions/payment/advhutf'] }] },
    ],
  },
  {
    name: 'mesa_mono_nudge',
    language: 'en',
    category: 'UTILITY',
    bodyText: '💳 Want automatic payment confirmation?\n\nConnect your bank account through Mono, and Mesa will automatically confirm payments using real bank transactions. No screenshots needed.\n\nVisit your Mesa dashboard to get started. 🚀',
    components: [
      bodyComponent('💳 Want automatic payment confirmation?\n\nConnect your bank account through Mono, and Mesa will automatically confirm payments using real bank transactions. No screenshots needed.\n\nVisit your Mesa dashboard to get started. 🚀'),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Connect Bank', url: 'https://app.getmesa.co/onboarding/mono' }, { type: 'QUICK_REPLY', text: 'Not Now' }] },
    ],
  },
  {
    name: 'mesa_setup_complete',
    language: 'en',
    category: 'UTILITY',
    bodyText: "🎉 Your Mesa setup is complete.\n\nMesa is now active for {{1}}.\n\nWhenever something needs your attention, we'll send you a message here with a link to take action. 🚀",
    components: [
      bodyComponent("🎉 Your Mesa setup is complete.\n\nMesa is now active for {{1}}.\n\nWhenever something needs your attention, we'll send you a message here with a link to take action. 🚀", ['Chidi Stores']),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open Dashboard', url: 'https://app.getmesa.co/' }] },
    ],
  },
  {
    name: 'mesa_connection_success',
    language: 'en',
    category: 'UTILITY',
    bodyText: '🎉 Your WhatsApp Business number has been successfully connected to Mesa! Complete your account setup in the Mesa dashboard to start managing orders, payments, and customers. 🚀',
    components: [
      bodyComponent('🎉 Your WhatsApp Business number has been successfully connected to Mesa! Complete your account setup in the Mesa dashboard to start managing orders, payments, and customers. 🚀'),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Complete Setup', url: 'https://app.getmesa.co/onboarding/setup' }] },
    ],
  },
  {
    name: 'mesa_low_inventory',
    language: 'en',
    category: 'UTILITY',
    bodyText: '⚠️ Stock is running low.\n\n📦 {{1}} has only {{2}} units remaining.\n\nVisit your Mesa dashboard to update your inventory and avoid stockouts.',
    components: [
      bodyComponent('⚠️ Stock is running low.\n\n📦 {{1}} has only {{2}} units remaining.\n\nVisit your Mesa dashboard to update your inventory and avoid stockouts.', ['Ankara Fabric', '3']),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Update Stock', url: 'https://app.getmesa.co/inventory' }] },
    ],
  },
  {
    name: 'mesa_daily_summary',
    language: 'en',
    category: 'UTILITY',
    bodyText: '📊 Your business summary for today\n\nOrders confirmed: {{1}}\nRevenue collected: {{2}}\nPending orders: {{3}}\n\nLog in to your Mesa dashboard to view full details and take action. 🚀',
    components: [
      bodyComponent('📊 Your business summary for today\n\nOrders confirmed: {{1}}\nRevenue collected: {{2}}\nPending orders: {{3}}\n\nLog in to your Mesa dashboard to view full details and take action. 🚀', ['5', '₦125,000', '2']),
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View Dashboard', url: 'https://app.getmesa.co/dashboard' }, { type: 'URL', text: 'View Order', url: 'https://app.getmesa.co/dashboard/orders' }] },
    ],
  },
  {
    name: 'mesa_login_code',
    language: 'en',
    category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ],
  },
]

// Substitute {{n}} placeholders so a not-yet-approved template can still reach
// the merchant as plain text instead of dying in notification_failures.
export function renderTemplateFallback(name: string, bodyParams: Array<string | number>): string | null {
  const definition = MESA_TEMPLATE_DEFINITIONS.find(t => t.name === name)
  if (!definition?.bodyText) return null
  return definition.bodyText.replace(/\{\{(\d+)\}\}/g, (_, index) => {
    const value = bodyParams[Number(index) - 1]
    return value != null ? String(value) : ''
  })
}
