import type { MesaNatsClient } from '@mesa/nats'
import { NotificationSendEvent } from '@mesa/types'
import { sendText } from '@mesa/whatsapp'

export class NotificationHandler {
  constructor(
    private nats: MesaNatsClient
  ) {}

  async handle(event: NotificationSendEvent): Promise<void> {
    const { toPhone, message } = event
    await sendText(toPhone, message)
  }
}
