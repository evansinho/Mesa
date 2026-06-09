// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_payment_confirmed.ts
// Sent when Mono webhook confirms a payment automatically. No merchant action required.


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_payment_confirmed',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Payment confirmed.\n\nOrder: {{1}}\n\nAmount: {{2}}\n\nMesa confirmed this payment from your connected bank account.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'View Order',
            url: 'https://app.getmesa.co/actions/order/{{1}}',
          },
        ],
      },
    ],
  }

  const res = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(template),
  })

  console.log(JSON.stringify(await res.json(), null, 2))
})().catch(console.error)
