// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_new_order_v3.ts
// Variables: {{1}} = customer name/phone, {{2}} = item summary, {{3}} = detected total.
// Buttons are quick replies only; URL review remains a fallback via "LINK".

;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_new_order_v3',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'New order received.\n\nCustomer: {{1}}\n\n{{2}}\n\nDetected total: {{3}}\n\nReply or tap:\nACCEPT - confirm this order\nREJECT - cancel it\nOr send the correct total, e.g. 140000\n\nTo change items too, send: 2x rice, 1x beans = 180000\nReply LINK for the review page.',
        example: {
          body_text: [['John Doe (+2348012345678)', '2x rice\n1x beans', '₦180,000']],
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
            text: 'Reject',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Edit total',
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
