// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_new_order.ts
//
// Two variants below. Run ONE depending on whether Meta accepts mixed quick_reply + URL buttons.
//
// Variant A (preferred): Accept (quick_reply) + Edit (URL) + Reject (quick_reply)
// Variant B (fallback):  Accept (quick_reply) + Review (URL, same target) + Reject (quick_reply)
//
// Set TEMPLATE_VARIANT=A (default) or TEMPLATE_VARIANT=B


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!
  const variant = (process.env.TEMPLATE_VARIANT ?? 'A').toUpperCase()

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const urlButtonLabel = variant === 'B' ? 'Review' : 'Edit'

  // NOTE: Meta may reject mixed quick_reply + URL button templates.
  // If Variant A is rejected, resubmit with Variant B (different name or overwrite).
  // Both variants send to the same action page URL — the button label differs.

  const template = {
    name: 'mesa_new_order',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'New order.\n\nCustomer: {{1}}\n\n{{2}}\n\nEstimated total: {{3}}\n\nPlease review this order before processing.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'QUICK_REPLY',
            text: 'Accept',
          },
          {
            type: 'URL',
            text: urlButtonLabel,
            url: 'https://app.getmesa.co/actions/order/{{1}}',
          },
          {
            type: 'QUICK_REPLY',
            text: 'Reject',
          },
        ],
      },
    ],
  }

  console.log(`Registering mesa_new_order (Variant ${variant}) — URL button label: "${urlButtonLabel}"`)

  const res = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(template),
  })

  console.log(JSON.stringify(await res.json(), null, 2))
})().catch(console.error)
