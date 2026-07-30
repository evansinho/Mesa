// @mono.co/connect.js ships no TypeScript types (registry "types": null) —
// this covers only the subset of their widget API this app actually calls.
declare module '@mono.co/connect.js' {
  export interface MonoConnectCustomer {
    id?: string
    name?: string
    email?: string
  }

  export interface MonoConnectConfig {
    key: string
    scope?: 'auth' | 'payments'
    data?: { customer: MonoConnectCustomer }
    onSuccess?: (data: { code: string }) => void
    onClose?: () => void
    onLoad?: () => void
    onEvent?: (eventName: string, data: unknown) => void
    reference?: string
  }

  export default class Connect {
    constructor(config: MonoConnectConfig)
    setup(): void
    open(): void
    close(): void
    reauthorise(accountId: string): void
  }
}
