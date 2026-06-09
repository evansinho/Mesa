// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_connection_success.ts

;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_connection_success',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Your WhatsApp Business number has been successfully connected to Mesa.\n\nComplete your account setup in the Mesa dashboard to start managing orders, payments, and customers.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Complete Setup',
            url: 'https://app.getmesa.co/onboarding/setup',
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
