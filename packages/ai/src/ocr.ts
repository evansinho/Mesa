import Anthropic from '@anthropic-ai/sdk'
import type { OCRResult } from '@mesa/types'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an OCR assistant specialised in reading Nigerian bank transfer screenshots.

Nigerian banking apps you may encounter: OPay, Kuda, GTBank, Access Bank, Zenith Bank,
Palmpay, Moniepoint, FirstBank, UBA, Stanbic IBTC, Sterling Bank, and others.

Extract the payment details accurately. If a field is not visible or unclear, omit it.
The amount should be in Naira (NGN) as a plain number — strip commas and currency symbols.`

export async function extractPaymentDetails(
  screenshotUrl: string
): Promise<OCRResult> {
  const { base64Image, mediaType } = await fetchImageAsBase64(screenshotUrl)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', // use sonnet for vision accuracy
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'extract_payment',
        description: 'Extract payment details from a bank transfer screenshot',
        input_schema: {
          type: 'object' as const,
          properties: {
            amount: {
              type: 'number',
              description: 'Transfer amount in Naira as a plain number (e.g. 42000 not ₦42,000)',
            },
            reference: {
              type: 'string',
              description: 'Transaction reference or session ID',
            },
            bankName: {
              type: 'string',
              description: 'Sending bank name',
            },
            accountName: {
              type: 'string',
              description: 'Account name of sender',
            },
            transactionDate: {
              type: 'string',
              description: 'Transaction date and time as shown',
            },
            confidence: {
              type: 'number',
              description: '0-1 confidence that this is a valid completed transfer screenshot',
            },
          },
          required: ['confidence'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_payment' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Extract the payment details from this bank transfer screenshot.',
          },
        ],
      },
    ],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    return { confidence: 0, rawText: '' }
  }

  const result = toolUse.input as {
    amount?: number
    reference?: string
    bankName?: string
    accountName?: string
    transactionDate?: string
    confidence: number
  }

  return {
    amount: result.amount,
    reference: result.reference,
    bankName: result.bankName,
    accountName: result.accountName,
    transactionDate: result.transactionDate,
    confidence: result.confidence,
    rawText: JSON.stringify(result),
  }
}

type AllowedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

async function fetchImageAsBase64(
  url: string
): Promise<{ base64Image: string; mediaType: AllowedMediaType }> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch screenshot: ${res.status}`)
  }
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
  const arrayBuffer = await res.arrayBuffer()
  const mediaType = normalizeMediaType(contentType)
  return {
    base64Image: Buffer.from(arrayBuffer).toString('base64'),
    mediaType,
  }
}

function normalizeMediaType(input: string): AllowedMediaType {
  switch (input) {
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
    case 'image/jpeg':
      return input
    default:
      return 'image/jpeg'
  }
}

// Confidence threshold below which we flag for manual review
export const OCR_CONFIDENCE_THRESHOLD = 0.75
