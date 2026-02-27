import { getDb, closeDb } from './client'
import { merchants, products, merchantChannels } from './schema/index'

async function main() {
  const db = getDb(process.env.DATABASE_URL || '')

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for seeding')
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'TEST_PHONE_NUMBER_ID'

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: 'Test Merchant',
      phone: '+2348012345678',
      businessType: 'FMCG Distributor',
      config: {
        bankAccount: {
          bankName: 'Test Bank',
          accountNumber: '0001234567',
          accountName: 'Test Merchant',
        },
      },
    })
    .returning({ id: merchants.id })

  await db.insert(merchantChannels).values({
    merchantId: merchant.id,
    channel: 'whatsapp',
    channelAccountId: phoneNumberId,
    status: 'connected',
  })

  await db.insert(products).values([
    {
      merchantId: merchant.id,
      name: 'Garri',
      description: 'Premium yellow garri',
      price: '800.00',
      stockQuantity: 100,
      lowStockThreshold: 10,
      unit: 'bag',
    },
    {
      merchantId: merchant.id,
      name: 'Rice 50kg',
      description: 'Long grain parboiled rice',
      price: '42000.00',
      stockQuantity: 40,
      lowStockThreshold: 5,
      unit: 'bag',
    },
  ])

  console.log(`Seeded merchant ${merchant.id} with products.`)
}

main()
  .catch(err => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDb()
  })
