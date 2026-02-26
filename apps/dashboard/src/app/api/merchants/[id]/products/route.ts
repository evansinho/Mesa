import { NextResponse } from 'next/server'
import { loadEnv } from '@/lib/load-env'

export async function GET(_: Request, { params }: { params: { id: string } }) {
  loadEnv()
  const merchantId = params.id

  const apiUrl = process.env.MESA_API_URL || 'http://localhost:3002'
  const internalKey = process.env.INTERNAL_API_KEY || ''

  const res = await fetch(`${apiUrl}/merchants/${merchantId}/products`, {
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
