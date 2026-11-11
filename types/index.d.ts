/** One model response, as the band reads it. */
export type Reading = {
  /** The model id the API reported, or the step's model while it streams. */
  model: string
  /** Output tokens per second over the response's generation window. */
  tps: number
  /** Output tokens: exact once the response stops, estimated while it streams. */
  tokens: number
  /** Generation window: first piece of the response to its stop, in ms. */
  ms: number
  /** Request sent to the first piece of the response, in ms; null if none came. */
  ttftMs: number | null
  /** True once the API's usage was read. */
  isExact: boolean
}

export type MeterState = {
  /** The response arriving now. */
  live: Reading | null
  /** The last response that stopped. */
  last: Reading | null
  /** When `last` was written, on `$.clock.now()`'s clock. */
  lastAt: number
  /** The last few exact readings, for the average. */
  recent: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'tps-band': {
      meter: MeterState
    }
  }
}
