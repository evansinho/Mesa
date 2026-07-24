import { send } from '../src/index'

describe('send — Instagram media', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('sends the attachment then a follow-up text when both mediaUrl and a caption are present', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), body: JSON.parse(init!.body as string) })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    await send('instagram', 'igsid_1', 'Here is your item', {
      pageId: 'page_123',
      pageAccessToken: 'token_123',
      mediaUrl: 'https://cdn.instagram.test/product.jpg',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].body).toMatchObject({
      recipient: { id: 'igsid_1' },
      message: { attachment: { type: 'image', payload: { url: 'https://cdn.instagram.test/product.jpg', is_reusable: true } } },
    })
    expect(calls[1].body).toMatchObject({
      recipient: { id: 'igsid_1' },
      message: { text: 'Here is your item' },
    })
  })

  it('sends only the attachment when there is no caption', async () => {
    const calls: Array<{ body: unknown }> = []
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init!.body as string) })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    await send('instagram', 'igsid_1', '', {
      pageId: 'page_123',
      pageAccessToken: 'token_123',
      mediaUrl: 'https://cdn.instagram.test/product.jpg',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({
      message: { attachment: { type: 'image' } },
    })
  })

  it('sends plain text when there is no mediaUrl', async () => {
    const calls: Array<{ body: unknown }> = []
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init!.body as string) })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    await send('instagram', 'igsid_1', 'Hello', { pageId: 'page_123', pageAccessToken: 'token_123' })

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ message: { text: 'Hello' } })
  })
})
