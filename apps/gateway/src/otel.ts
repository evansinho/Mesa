import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { Resource } from '@opentelemetry/resources'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'

const exporter = new OTLPTraceExporter()
const prometheus = new PrometheusExporter({ port: 9464 })

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'gateway',
  }),
  traceExporter: exporter,
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
