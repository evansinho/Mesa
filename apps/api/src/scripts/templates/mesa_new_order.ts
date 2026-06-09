// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_new_order.ts
// Variables: {{1}} = customer name/phone, {{2}} = item summary, {{3}} = estimated total.
// Note: registered with 3 quick_reply buttons only (Meta rejects mixed quick_reply + URL).
// Set MESA_ORDER_TEMPLATE_HAS_URL_EDIT=false in production.

;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_new_order',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'New order.\n\nCustomer: {{1}}\n\n{{2}}\n\nEstimated total: {{3}}\n\nPlease review this order before processing.',
        example: {
          body_text: [['John Doe (+2348012345678)', '2x Ankara Fabric\n1x Plain White Shirt', '₦15,000']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'QUICK_REPLY',
            text: 'Accept',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Edit',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Reject',
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
