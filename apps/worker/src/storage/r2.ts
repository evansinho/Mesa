import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '@mesa/config'
import { randomUUID } from 'crypto'

const client = new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT,
  credentials: config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY
    ? {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      }
    : undefined,
})

export async function uploadScreenshot(buffer: Buffer, contentType?: string): Promise<string> {
  if (!config.R2_BUCKET_NAME || !config.R2_ENDPOINT) {
    throw new Error('R2 configuration missing')
  }

  const key = `screenshots/${randomUUID()}`
  await client.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))

  return `${config.R2_ENDPOINT}/${config.R2_BUCKET_NAME}/${key}`
}
