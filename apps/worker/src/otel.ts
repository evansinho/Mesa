import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { Resource } from '@opentelemetry/resources'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'

const prometheus = new PrometheusExporter({ port: 9466 })

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'worker',
  }),
  metricReader: prometheus,
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()

process.on('SIGTERM', () => {
  sdk.shutdown().catch(() => undefined)
})

process.on('SIGINT', () => {
  sdk.shutdown().catch(() => undefined)
})
