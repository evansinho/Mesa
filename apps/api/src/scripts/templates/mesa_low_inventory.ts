// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_low_inventory.ts
// Sent when product stock falls below threshold.


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_low_inventory',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Stock is running low.\n\n{{1}} has {{2}} units remaining.\n\nVisit your dashboard to update stock.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Update Stock',
            url: 'https://app.getmesa.co/actions/inventory/{{1}}',
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
