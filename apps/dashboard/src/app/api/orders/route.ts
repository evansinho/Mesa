import { NextResponse } from 'next/server'
import { loadEnv } from '@/lib/load-env'

export async function GET(req: Request) {
  loadEnv()
  const { searchParams } = new URL(req.url)
  const merchantId = searchParams.get('merchantId')
  const status = searchParams.get('status')

  if (!merchantId) {
    return NextResponse.json({ error: 'merchantId is required' }, { status: 400 })
  }

  const apiUrl = process.env.MESA_API_URL || 'http://localhost:3002'
  const internalKey = process.env.INTERNAL_API_KEY || ''

  const url = new URL(`${apiUrl}/orders`)
  url.searchParams.set('merchantId', merchantId)
  if (status) url.searchParams.set('status', status)

  const res = await fetch(url.toString(), {
    headers: {
      'x-mesa-api-key': internalKey,
    },
  })

  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  })
}
