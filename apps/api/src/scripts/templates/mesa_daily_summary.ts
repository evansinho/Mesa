// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_daily_summary.ts
// Sent at end of business day (~20:00 WAT). Only sent if merchant had activity that day.
// Variables: {{1}} = confirmed order count, {{2}} = total revenue, {{3}} = pending order count.

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
        text: 'Here is your business summary for today.\n\nOrders confirmed: {{1}}\nRevenue collected: {{2}}\nPending orders: {{3}}\n\nLog in to view full details and take action.',
        example: {
          body_text: [['5', '₦125,000', '2']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'View Dashboard',
            url: 'https://app.getmesa.co/dashboard',
          },
          {
            type: 'URL',
            text: 'View Orders',
            url: 'https://app.getmesa.co/dashboard/orders',
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
