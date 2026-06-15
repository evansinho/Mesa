// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_payment_confirmed.ts
// Sent to the merchant when payment is confirmed. Also starts fulfilment.
// Variables:
// {{1}} = order reference
// {{2}} = customer name/phone
// {{3}} = item summary
// {{4}} = total paid

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
        text: '✅ Payment confirmed.\n\nOrder: {{1}}\nCustomer: {{2}}\n\n{{3}}\n\nTotal paid: {{4}}\n\nHow should this order be fulfilled?\n\nReply or tap:\nBOOK RIDER - collect address and prepare dispatch\nSELF DELIVER - you will handle delivery\nPICKUP - customer will pick up\nLINK - open Mesa',
        example: {
          body_text: [['ORD-12345678', 'John(08000000)', '1x blue shirt', '₦15000']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Book Rider' },
          { type: 'QUICK_REPLY', text: 'Self Deliver' },
          { type: 'QUICK_REPLY', text: 'Pickup' },
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
