// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_setup_complete.ts


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_setup_complete',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Your Mesa setup is complete.\n\nMesa is now active for {{1}}.\n\nWhenever something needs your attention, we will send you a message here with a link to act.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Open Dashboard',
            url: 'https://app.getmesa.co/{{1}}',
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
