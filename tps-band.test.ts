import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
}

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 12,
  output_tokens: 120,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const RESULT = {
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: USAGE,
}

/** The engine's own drawing, beneath the plugin, wherever the band yields. */
function engine(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: ['prompt'] }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', e => ({ turnId: e.turnId }))
}

test('the band shows a live estimate, then the exact speed', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  engine(on)

  on('turn.step', async function* () {
    await clock.sleep(700)

    for (let i = 0; i < 40; i += 1) {
      yield { kind: 'text', index: 0, text: 'hello world ' }
    }

    await clock.sleep(2_000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return RESULT
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })

  // The request goes out at 1_000; the first token arrives 700ms later.
  const pendingFirst = stream.next()
  await clock.advance(700)
  await pendingFirst

  // Sixteen chunks: the live window is still empty, so nothing is drawn yet.
  for (let i = 0; i < 15; i += 1) {
    await stream.next()
  }

  // Past 700ms the estimate may show; the next check is on chunk 32.
  await clock.advance(750)
  for (let i = 0; i < 16; i += 1) {
    await stream.next()
  }

  const live = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  expect((await live.find({ type: 'Text', text: /tok\/s/ }))?.text).toContain('~')
  await live.unmount()

  for (let i = 0; i < 8; i += 1) {
    await stream.next()
  }

  // Two seconds of generation, then the stop with the API's exact usage:
  // 120 tokens over 2.75s is 43.6 tok/s.
  const pendingStop = stream.next()
  await clock.advance(2_000)
  await pendingStop
  await stream.next()

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'tps-band', surface, ...BAND })
    const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

    expect(text).toContain('43.6 tok/s')
    expect(text).toContain('120 tok')
    expect(text).toContain('TTFT 700ms')
    expect(text).not.toContain('~')

    await ui.unmount()
  }
})

test('the band sums a turn of several responses', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on)

  on('turn.step', async function* (_, e) {
    await clock.sleep(500)
    yield { kind: 'text', index: 0, text: 'x'.repeat(30) }
    await clock.sleep(1_000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return { ...RESULT, turnId: e.turnId, index: e.index }
  })

  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't2', index, model: 'claude-opus-5-5', messageCount: 1 })
    const pendingFirst = stream.next()
    await clock.advance(500)
    await pendingFirst
    const pendingStop = stream.next()
    await clock.advance(1_000)
    await pendingStop
    await stream.next()
  }

  await step(0)
  await step(1)
  await $.turn.complete({ answer: '', durationMs: 3_000, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

  expect(text).toContain('120 tok/s')
  expect(text).toContain('2 steps')
  expect(text).toContain('240 tok')
  expect(text).toContain('2.0s')
  await ui.unmount()

  // Narrow: the step count stays, the model and the sparkline go.
  const narrow = await $.ui.mount({
    plugin: 'tps-band',
    surface: 'desktop',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 50 },
  })
  const narrowText = (await narrow.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

  expect(narrowText).toContain('120 tok/s')
  expect(narrowText).toContain('2 steps')
  expect(narrowText).not.toContain('opus')
  await narrow.unmount()

  // The default retention clears the reading a minute after the turn.
  await clock.advance(60_000)
  const cleared = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  expect(await cleared.find({ type: 'Text', text: /tok\/s/ })).toBeUndefined()
  await cleared.unmount()
})

test('end-to-end mode counts the wait for the first token', { options: { speedMode: 'end-to-end' }, timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on)

  on('turn.step', async function* () {
    await clock.sleep(500)
    yield { kind: 'text', index: 0, text: 'x'.repeat(30) }
    await clock.sleep(1_000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return RESULT
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const pendingFirst = stream.next()
  await clock.advance(500)
  await pendingFirst
  const pendingStop = stream.next()
  await clock.advance(1_000)
  await pendingStop
  await stream.next()

  const ui = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

  // 120 tokens over the whole 1.5s request, not the 1.0s generation window.
  expect(text).toContain('80.0 tok/s e2e')
  expect(text).toContain('TTFT 500ms')
  await ui.unmount()
})

test('an interrupted response keeps a partial reading', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on)

  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'x'.repeat(40) }
    yield { kind: 'text', index: 0, text: 'x'.repeat(40) }
    await clock.sleep(10_000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return RESULT
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  await stream.next()
  await stream.next()
  await clock.advance(500)
  await stream.return(RESULT)

  const ui = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

  // Estimated tokens, a window that was cut short: shown, and marked as such.
  expect(text).toContain('~')
  expect(text).toContain('tok/s')
  await ui.unmount()
})
