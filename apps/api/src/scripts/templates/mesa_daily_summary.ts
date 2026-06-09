// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_daily_summary.ts
// Sent at end of business day (~20:00 WAT). Only sent if merchant had activity that day.
// Variables: {{1}} confirmed order count, {{2}} total revenue, {{3}} confirmed payments, {{4}} pending order count.


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_daily_summary',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Daily summary.\n\nOrders: {{1}}\n\nRevenue: {{2}}\n\nPayments received: {{3}}\n\nPending: {{4}}',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'View Dashboard',
            url: 'https://app.getmesa.co/{{1}}',
          },
          {
            type: 'URL',
            text: 'View Orders',
            url: 'https://app.getmesa.co/{{2}}',
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
