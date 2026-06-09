// Usage: WHATSAPP_ACCESS_TOKEN=... WABA_ID=... npx tsx apps/api/src/scripts/templates/mesa_payment_needs_confirmation.ts
// Sent for all screenshot/OCR-based payment proofs when Mono is not connected or amount mismatches.
// Covers reasons: low_confidence, amount_mismatch, reference_reused, mono_required, mono_failed.


;(async () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!
  const wabaId = process.env.WABA_ID!

  if (!accessToken || !wabaId) {
    console.error('WHATSAPP_ACCESS_TOKEN and WABA_ID are required')
    process.exit(1)
  }

  const template = {
    name: 'mesa_payment_needs_confirmation',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Payment needs confirmation.\n\nOrder: {{1}}\n\nCustomer: {{2}}\n\nAmount: {{3}}\n\nMesa found a payment proof, but your bank account is not connected.\n\nPlease confirm only after checking your bank account.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'QUICK_REPLY',
            text: 'Confirm Payment',
          },
          {
            type: 'URL',
            text: 'Review',
            url: 'https://app.getmesa.co/actions/payment/{{1}}',
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
