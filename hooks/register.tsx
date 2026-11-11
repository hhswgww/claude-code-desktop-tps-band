import { atom, read, update } from 'claude-code'
import type { Register, TurnStepResult } from 'claude-code'

import type { MeterState, Reading, TurnSummary } from '../types'

const METER = { plugin: 'tps-band', key: 'meter' } as const

const EMPTY: MeterState = { live: null, last: null, lastAt: 0, recent: [], turn: null }

const meter = atom(METER, EMPTY)

/** A live number waits for a window this long, so early jitter never shows. */
const LIVE_MIN_MS = 700

/** Content chunks between live checks: one state write per ~16 tokens at most. */
const PUSH_EVERY = 16

/** Floor between live redraws, so a fast model cannot redraw per token. */
const PUSH_MIN_INTERVAL_MS = 250

/** Completed readings kept for the average and the sparkline. */
const RECENT_STEPS = 12

/** Below this width the line keeps only its speed and window. */
const MEDIUM_COLUMNS = 58

/** At or above this width the line shows everything it has. */
const WIDE_COLUMNS = 86

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

type Mode = 'generation' | 'end-to-end' | 'both'

/**
 * Approximate token count of streamed text, used only while a response is
 * still arriving (the exact count comes from `usage` when it stops). CJK
 * characters run near a token each; Latin text and code near a quarter.
 */
function estimate(text: string): number {
  let n = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp >= 0x2e80 ? 0.7 : 0.26
  }

  return n
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1_000)}k`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`
  }
  return `${Math.round(n)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }

  const seconds = ms / 1000

  if (seconds < 100) {
    return `${seconds.toFixed(1)}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m${Math.round(seconds - minutes * 60)}s` : `${Math.round(seconds)}s`
}

function formatTps(tps: number): string {
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)
}

function shortModel(model: string): string {
  const short = model.replace(/^claude-/, '')

  return short.length > 24 ? `${short.slice(0, 23)}…` : short
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Twelve bars over the recent readings, flat for a flat history. */
function sparkline(values: readonly number[]): string {
  if (values.length < 3) {
    return ''
  }

  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low

  return values
    .slice(-RECENT_STEPS)
    .map(value => BLOCKS[span === 0 ? 3 : Math.min(7, Math.floor(((value - low) / span) * 7))] ?? '▄')
    .join('')
}

export const register: Register = (on, options) => {
  const mode: Mode =
    options.speedMode === 'end-to-end' || options.speedMode === 'both' ? options.speedMode : 'generation'

  const retainSeconds =
    typeof options.retainSeconds === 'number' &&
    Number.isFinite(options.retainSeconds) &&
    options.retainSeconds >= 0
      ? options.retainSeconds
      : 60

  const showSparkline = options.showSparkline !== false

  const primary = (reading: Reading): number => (mode === 'end-to-end' ? reading.e2eTps : reading.tps)
  const windowMs = (reading: Reading): number => (mode === 'end-to-end' ? reading.e2eMs : reading.ms)

  const turnTps = (turn: TurnSummary): number =>
    (turn.tokens * 1000) / Math.max(1, mode === 'end-to-end' ? turn.e2eMs : turn.genMs)
  const turnE2eTps = (turn: TurnSummary): number => (turn.tokens * 1000) / Math.max(1, turn.e2eMs)
  const turnWindowMs = (turn: TurnSummary): number => (mode === 'end-to-end' ? turn.e2eMs : turn.genMs)

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()

      await update($, meter, state => ({
        ...state,
        live: null,
        turn: { steps: 0, tokens: 0, genMs: 0, e2eMs: 0, startedAt: now, endedAt: 0 },
      }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent's steps stream in their own loop; the band watches the main one.
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const stream = next(e)
    const startedAt = await $.clock.now()

    let firstAt: number | null = null
    let stopAt: number | null = null
    let units = 0
    let sincePush = 0
    let lastPushAt = 0
    let isRecorded = false

    const record = async (reading: Reading, endedAt: number) => {
      await update($, meter, state => {
        const turn: TurnSummary = state.turn ?? {
          steps: 0,
          tokens: 0,
          genMs: 0,
          e2eMs: 0,
          startedAt,
          endedAt: 0,
        }

        return {
          ...state,
          live: null,
          last: reading,
          lastAt: endedAt,
          recent: [...state.recent, primary(reading)].slice(-RECENT_STEPS),
          turn: {
            ...turn,
            steps: turn.steps + 1,
            tokens: turn.tokens + reading.tokens,
            genMs: turn.genMs + reading.ms,
            e2eMs: turn.e2eMs + reading.e2eMs,
            endedAt,
          },
        }
      })
    }

    // Runs once, on the normal return and on a stream cut short alike: an
    // interrupted response keeps what it had counted, marked approximate.
    const finish = async (usage: TurnStepResult['usage'] | null) => {
      if (isRecorded) {
        return
      }
      isRecorded = true

      const endedAt = stopAt ?? (await $.clock.now())
      const from = firstAt ?? startedAt
      const ms = Math.max(1, endedAt - from)
      const tokens = usage ? usage.output_tokens : Math.round(units)

      if (tokens <= 0) {
        await update($, meter, state => (state.live === null ? state : { ...state, live: null }))
        return
      }

      const e2eMs = Math.max(1, endedAt - startedAt)
      const reading: Reading = {
        model: usage?.model ?? e.model,
        tps: (tokens * 1000) / ms,
        e2eTps: (tokens * 1000) / e2eMs,
        tokens,
        ms,
        e2eMs,
        ttftMs: firstAt === null ? null : firstAt - startedAt,
        isExact: usage !== null,
      }

      await record(reading, endedAt)
    }

    let response: TurnStepResult | null = null

    try {
      let pull = await stream.next()

      while (!pull.done) {
        const chunk = pull.value

        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          units += estimate(chunk.text)
        } else if (chunk.kind === 'input') {
          units += estimate(chunk.json)
        }

        // The request is sent before this hook runs, so the first piece of the
        // response is the first token's arrival: time to first token.
        if (firstAt === null && chunk.kind !== 'engine') {
          firstAt = await $.clock.now()
        }

        if (chunk.kind === 'stop') {
          stopAt = await $.clock.now()
        } else if (firstAt !== null) {
          sincePush += 1

          if (sincePush >= PUSH_EVERY) {
            sincePush = 0
            const now = await $.clock.now()

            // A window too short to mean anything stays hidden; a redraw lands
            // no more often than PUSH_MIN_INTERVAL_MS.
            if (now - firstAt >= LIVE_MIN_MS && now - lastPushAt >= PUSH_MIN_INTERVAL_MS) {
              lastPushAt = now

              const ms = Math.max(1, now - firstAt)
              const tokens = Math.round(units)
              const e2eMs = Math.max(1, now - startedAt)
              const live: Reading = {
                model: e.model,
                tps: (tokens * 1000) / ms,
                e2eTps: (tokens * 1000) / e2eMs,
                tokens,
                ms,
                e2eMs,
                ttftMs: firstAt - startedAt,
                isExact: false,
              }

              await update($, meter, state => ({ ...state, live }))
            }
          }
        }

        yield chunk

        pull = await stream.next()
      }

      response = pull.value
    } finally {
      try {
        await finish(response?.usage ?? null)
      } catch {
        // The dispatch is gone; there is nothing left to record it against.
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()

      await update($, meter, state => ({
        ...state,
        live: null,
        turn: state.turn === null ? null : { ...state.turn, endedAt: now },
      }))

      if (retainSeconds > 0) {
        // Leave the reading up for a while, then clear it — unless a newer one
        // has landed in the meantime.
        $.clock.after(retainSeconds * 1000, () => {
          void update($, meter, state =>
            state.last !== null && state.lastAt <= now ? { ...state, last: null, turn: null } : state,
          ).catch(() => undefined)
        })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const state = await read($, meter)
    const reading = state.live ?? state.last

    if (reading === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const isLive = state.live !== null
    const turn = state.turn
    const isTurn = !isLive && turn !== null && turn.steps > 1 && turn.endedAt > 0
    const columns = e.props.bodyColumns

    const speed = isTurn ? turnTps(turn) : primary(reading)
    const approximate = isTurn ? false : !reading.isExact
    const suffix = mode === 'end-to-end' ? ' e2e' : ''
    const average = state.recent.length >= 2 ? mean(state.recent) : 0
    const spark = showSparkline ? sparkline(state.recent) : ''
    const details: string[] = []

    if (columns >= WIDE_COLUMNS) {
      if (isTurn) {
        details.push(`${turn.steps} steps`, `${formatTokens(turn.tokens)} tok`, formatDuration(turnWindowMs(turn)))

        if (mode === 'both') {
          details.push(`e2e ${formatTps(turnE2eTps(turn))}`)
        }
      } else {
        details.push(`${formatTokens(reading.tokens)} tok`, formatDuration(windowMs(reading)))

        if (mode === 'both') {
          details.push(`e2e ${formatTps(reading.e2eTps)}`)
        }
        if (!isLive) {
          if (reading.ttftMs !== null) {
            details.push(`TTFT ${formatDuration(reading.ttftMs)}`)
          }
          if (average > 0) {
            details.push(`avg ${formatTps(average)}`)
          }
        }
      }

      if (spark !== '') {
        details.push(spark)
      }
      details.push(shortModel(reading.model))
    } else if (columns >= MEDIUM_COLUMNS) {
      if (isTurn) {
        details.push(`${turn.steps} steps`, `${formatTokens(turn.tokens)} tok`)
      } else {
        details.push(`${formatTokens(reading.tokens)} tok`, formatDuration(windowMs(reading)))
      }

      if (spark !== '' && !isTurn) {
        details.push(spark)
      }
      details.push(shortModel(reading.model))
    } else if (isTurn) {
      details.push(`${turn.steps} steps`)
    } else {
      details.push(formatDuration(windowMs(reading)))
    }

    return (
      <Box>
        <Text wrap="truncate-end" tabular>
          <Text color={isLive ? 'success' : undefined} dimColor={!isLive} weight="semibold" tabular>
            {isLive ? '● ' : '○ '}
            {approximate ? '~' : ''}
            {formatTps(speed)} tok/s{suffix}
          </Text>
          <Text dimColor> · {details.join(' · ')}</Text>
        </Text>
      </Box>
    )
  })
}
