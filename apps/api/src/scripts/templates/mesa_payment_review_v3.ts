// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_payment_review_v3.ts
// Variables: {{1}} = order ref, {{2}} = customer name, {{3}} = expected amount, {{4}} = received amount, {{5}} = review reason.
// Buttons are quick replies only; URL review remains a fallback via "LINK".

;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_payment_review_v3',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Payment needs review.\n\nOrder: {{1}}\nCustomer: {{2}}\nExpected: {{3}}\nReceived: {{4}}\nReason: {{5}}\n\nReply or tap:\nCONFIRM - mark payment paid\nNOT YET - check again later\nDISPUTE - mark for follow-up\nLINK - open review page',
        example: {
          body_text: [['ORD-12345678', 'John Doe', '₦25,000', '₦25,000', 'Bank account not connected']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'QUICK_REPLY',
            text: 'Confirm',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Not yet',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Dispute',
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
