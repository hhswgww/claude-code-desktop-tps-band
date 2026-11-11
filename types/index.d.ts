/** One model response, as the band reads it. */
export type Reading = {
  /** The model id the API reported, or the step's model while it streams. */
  model: string
  /** Output tokens per second over the response's generation window. */
  tps: number
  /** Output tokens per second over the whole request (time to first token included). */
  e2eTps: number
  /** Output tokens: exact once the response stops, estimated while it streams. */
  tokens: number
  /** Generation window: first piece of the response to its stop, in ms. */
  ms: number
  /** Request sent to the stop, in ms: generation, plus the time to first token. */
  e2eMs: number
  /** Request sent to the first piece of the response, in ms; null if none came. */
  ttftMs: number | null
  /** True once the API's usage was read. */
  isExact: boolean
}

/** What one turn's model responses came to. */
export type TurnSummary = {
  /** Responses that stopped (or were cut) with tokens counted. */
  steps: number
  /** Output tokens over the whole turn. */
  tokens: number
  /** Summed generation windows, in ms. */
  genMs: number
  /** Summed request-to-stop times, in ms. */
  e2eMs: number
  /** When the turn began, on `$.clock.now()`'s clock. */
  startedAt: number
  /** When the turn completed; 0 while it runs. */
  endedAt: number
}

export type MeterState = {
  /** The response arriving now. */
  live: Reading | null
  /** The last response that stopped. */
  last: Reading | null
  /** When `last` was written, on `$.clock.now()`'s clock. */
  lastAt: number
  /** The last few readings' chosen speed, for the average and the sparkline. */
  recent: number[]
  /** The turn in progress or the one that just ended. */
  turn: TurnSummary | null
}

declare module 'claude-code' {
  interface PluginState {
    'tps-band': {
      meter: MeterState
    }
  }
}
