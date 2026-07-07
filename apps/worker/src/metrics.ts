import { metrics } from '@opentelemetry/api'

// Domain counters for the detect-and-confirm funnel. Exported to Prometheus
// by the exporter in otel.ts; names become mesa_*_total.
const meter = metrics.getMeter('mesa-worker')

export const inboundCustomerMessages = meter.createCounter('mesa.messages.inbound_customer', {
  description: 'Customer messages processed by the worker',
})

export const agentTasksCreated = meter.createCounter('mesa.agent_tasks.created', {
  description: 'Pending merchant decisions created, by task type (order taps, payment reviews, ...)',
})

export const ordersConfirmed = meter.createCounter('mesa.orders.confirmed', {
  description: 'Orders confirmed by the merchant',
})

export const paymentsAutoConfirmed = meter.createCounter('mesa.payments.auto_confirmed', {
  description: 'Payments confirmed automatically via OCR/Mono without merchant review',
})

export const notificationFailures = meter.createCounter('mesa.notifications.failed', {
  description: 'Outbound WhatsApp/Instagram notification failures',
})
