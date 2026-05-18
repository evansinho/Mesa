import Anthropic from '@anthropic-ai/sdk'
import type { OCRResult } from '@mesa/types'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an OCR assistant specialised in reading Nigerian bank transfer screenshots.

Nigerian banking apps you may encounter: OPay, Kuda, GTBank, Access Bank, Zenith Bank,
Palmpay, Moniepoint, FirstBank, UBA, Stanbic IBTC, Sterling Bank, and others.

Extract the payment details accurately. If a field is not visible or unclear, omit it.
The amount should be in Naira (NGN) as a plain number — strip commas and currency symbols.`

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

// Two-tier OCR (F-10b): try Haiku first (12x cheaper); escalate to Sonnet
// only when Haiku's confidence falls below this threshold. The threshold is
// higher than the downstream auto-confirm threshold (OCR_CONFIDENCE_THRESHOLD)
// so we don't trust marginal Haiku reads — we'd rather burn Sonnet on the
// edge cases than confirm a payment off a shaky read.
export const HAIKU_ESCALATION_THRESHOLD = 0.85

type ExtractedFields = {
  amount?: number
  reference?: string
  bankName?: string
  accountName?: string
  transactionDate?: string
  confidence: number
}

async function runExtraction(
  model: string,
  base64Image: string,
  mediaType: AllowedMediaType,
): Promise<ExtractedFields | null> {
  const response = await client.messages.create({
    model,
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
  if (!toolUse || toolUse.type !== 'tool_use') return null
  return toolUse.input as ExtractedFields
}

export async function extractPaymentDetails(
  screenshotUrl: string
): Promise<OCRResult> {
  const { base64Image, mediaType } = await fetchImageAsBase64(screenshotUrl)

  // First pass: Haiku (cheap). Most legitimate bank screenshots have
  // consistent layouts and clean text; Haiku should handle ~80% confidently.
  const haiku = await runExtraction(HAIKU_MODEL, base64Image, mediaType)

  if (haiku && haiku.confidence >= HAIKU_ESCALATION_THRESHOLD) {
    return {
      amount: haiku.amount,
      reference: haiku.reference,
      bankName: haiku.bankName,
      accountName: haiku.accountName,
      transactionDate: haiku.transactionDate,
      confidence: haiku.confidence,
      rawText: JSON.stringify(haiku),
      modelUsed: 'haiku',
      escalated: false,
    }
  }

  // Escalation: rerun with Sonnet (vision-strong). Haiku's read is discarded;
  // Sonnet's result is authoritative. The aiUsage row for the Haiku call is
  // recorded separately by the caller so the cost dashboard sees both.
  const sonnet = await runExtraction(SONNET_MODEL, base64Image, mediaType)
  if (!sonnet) {
    return { confidence: 0, rawText: '', modelUsed: 'sonnet', escalated: true }
  }

  return {
    amount: sonnet.amount,
    reference: sonnet.reference,
    bankName: sonnet.bankName,
    accountName: sonnet.accountName,
    transactionDate: sonnet.transactionDate,
    confidence: sonnet.confidence,
    rawText: JSON.stringify(sonnet),
    modelUsed: 'sonnet',
    escalated: true,
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
