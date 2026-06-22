import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const MODEL = 'claude-haiku-4-5-20251001'

export type ProductVisionProduct = {
  name: string
  aliases?: string[]
  price?: number
  stockQuantity?: number | null
}

export type ProductImageAnalysis = {
  description?: string
  visibleText?: string[]
  candidateProductName?: string
  confidence: number
}

type AllowedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

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

async function fetchImageAsBase64(url: string): Promise<{ base64Image: string; mediaType: AllowedMediaType }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch product image: ${res.status}`)
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
  const arrayBuffer = await res.arrayBuffer()
  return {
    base64Image: Buffer.from(arrayBuffer).toString('base64'),
    mediaType: normalizeMediaType(contentType),
  }
}

export async function analyzeProductImage(
  imageUrl: string,
  products: ProductVisionProduct[] = [],
): Promise<ProductImageAnalysis> {
  const { base64Image, mediaType } = await fetchImageAsBase64(imageUrl)
  const catalog = products.slice(0, 80).map(product => ({
    name: product.name,
    aliases: product.aliases ?? [],
    price: product.price,
    stockQuantity: product.stockQuantity,
  }))

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    temperature: 0,
    system: [
      'You inspect customer product photos for a WhatsApp commerce assistant.',
      'Describe the visible product conservatively.',
      'If and only if the image clearly matches one product in the supplied catalog, return that exact product name.',
      'Do not invent products, prices, availability, sizes, or order status.',
    ].join('\n'),
    tools: [
      {
        name: 'analyze_product_image',
        description: 'Describe a customer product image and optionally match it to the supplied catalog.',
        input_schema: {
          type: 'object' as const,
          properties: {
            description: {
              type: 'string',
              description: 'Short visual description of the product in the image.',
            },
            visibleText: {
              type: 'array',
              items: { type: 'string' },
              description: 'Any readable text, brand, size, label, or SKU shown in the image.',
            },
            candidateProductName: {
              type: 'string',
              description: 'Exact catalog product name only when one product is a clear match.',
            },
            confidence: {
              type: 'number',
              description: '0-1 confidence in the candidateProductName. Use 0 when there is no clear catalog match.',
            },
          },
          required: ['confidence'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'analyze_product_image' },
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
            text: `Catalog:\n${JSON.stringify(catalog)}\n\nAnalyze this customer image.`,
          },
        ],
      },
    ],
  })

  const toolUse = response.content.find(block => block.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return { confidence: 0 }
  return toolUse.input as ProductImageAnalysis
}
