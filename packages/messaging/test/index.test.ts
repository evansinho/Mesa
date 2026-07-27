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
      igUserId: 'ig_user_123',
      igAccessToken: 'token_123',
      mediaUrl: 'https://cdn.instagram.test/product.jpg',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://graph.instagram.com/v21.0/ig_user_123/messages')
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
      igUserId: 'ig_user_123',
      igAccessToken: 'token_123',
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

    await send('instagram', 'igsid_1', 'Hello', { igUserId: 'ig_user_123', igAccessToken: 'token_123' })

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ message: { text: 'Hello' } })
  })

  it('attaches real tappable quick_replies to the Send API payload when provided', async () => {
    const calls: Array<{ body: unknown }> = []
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init!.body as string) })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    await send('instagram', 'igsid_1', 'New order received', {
      igUserId: 'ig_user_123',
      igAccessToken: 'token_123',
      quickReplies: [{ title: 'Accept', payload: 'accept' }, { title: 'Reject', payload: 'reject' }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({
      message: {
        text: 'New order received',
        quick_replies: [
          { content_type: 'text', title: 'Accept', payload: 'accept' },
          { content_type: 'text', title: 'Reject', payload: 'reject' },
        ],
      },
    })
  })

  it('omits quick_replies from the payload when none are provided', async () => {
    const calls: Array<{ body: unknown }> = []
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init!.body as string) })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    await send('instagram', 'igsid_1', 'Hello', { igUserId: 'ig_user_123', igAccessToken: 'token_123' })

    const body = calls[0].body as { message: Record<string, unknown> }
    expect(body.message).not.toHaveProperty('quick_replies')
  })
})
