import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { MeterState, Reading } from '../types'

const METER = { plugin: 'tps-band', key: 'meter' } as const

const EMPTY: MeterState = { live: null, last: null, lastAt: 0, recent: [] }

const meter = atom(METER, EMPTY)

/** How long a finished reading stays on screen with no turn running. */
const CLEAR_AFTER_MS = 60_000

/** Chunks between live redraws: one state write per ~8 tokens, not per token. */
const PUSH_EVERY = 8

/** Completed readings kept for the average. */
const RECENT_STEPS = 12

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

export const register: Register = on => {
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
          const ms = Math.max(1, now - firstAt)
          const tokens = Math.round(units)
          const live: Reading = {
            model: e.model,
            tps: (tokens * 1000) / ms,
            tokens,
            ms,
            ttftMs: firstAt - startedAt,
            isExact: false,
          }

          await update($, meter, state => ({ ...state, live }))
        }
      }

      yield chunk

      pull = await stream.next()
    }

    const response = pull.value
    const usage = response?.usage ?? null
    const endedAt = stopAt ?? (await $.clock.now())
    const from = firstAt ?? startedAt
    const ms = Math.max(1, endedAt - from)
    const tokens = usage ? usage.output_tokens : Math.round(units)
    const reading: Reading = {
      model: usage?.model ?? e.model,
      tps: (tokens * 1000) / ms,
      tokens,
      ms,
      ttftMs: firstAt === null ? null : firstAt - startedAt,
      isExact: usage !== null,
    }

    if (tokens > 0) {
      await update($, meter, state => ({
        ...state,
        live: null,
        last: reading,
        lastAt: endedAt,
        recent: [...state.recent, reading.tps].slice(-RECENT_STEPS),
      }))
    } else {
      await update($, meter, state => (state.live === null ? state : { ...state, live: null }))
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, meter, state => (state.live === null ? state : { ...state, live: null }))

      const clearBefore = await $.clock.now()

      // Leave the last reading up for a while, then clear it — unless a newer
      // one has landed in the meantime.
      $.clock.after(CLEAR_AFTER_MS, () => {
        void update($, meter, state =>
          state.last !== null && state.lastAt <= clearBefore ? { ...state, last: null } : state,
        ).catch(() => undefined)
      })
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
    const average =
      state.recent.length >= 2 ? state.recent.reduce((a, b) => a + b, 0) / state.recent.length : 0

    const details = [`${formatTokens(reading.tokens)} tok`, formatDuration(reading.ms)]

    if (reading.ttftMs !== null) {
      details.push(`TTFT ${formatDuration(reading.ttftMs)}`)
    }
    if (!isLive && average > 0) {
      details.push(`avg ${formatTps(average)}`)
    }
    details.push(shortModel(reading.model))

    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={isLive ? 'success' : undefined} dimColor={!isLive}>
            {isLive ? '● ' : '○ '}
            {reading.isExact ? '' : '~'}
            {formatTps(reading.tps)} tok/s
          </Text>
          <Text dimColor> · {details.join(' · ')}</Text>
        </Text>
      </Box>
    )
  })
}
