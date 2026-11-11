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

test('the band reads the exact output speed of a step', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })

  on('turn.step', async function* () {
    // 700ms to the first token, then nine pieces of text, then two seconds
    // of generation before the response stops.
    await clock.sleep(700)

    for (let i = 0; i < 9; i++) {
      yield { kind: 'text', index: 0, text: 'hello world ' }
    }

    await clock.sleep(2_000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return {
      turnId: 't1',
      index: 0,
      answer: 'hello world '.repeat(9),
      toolUses: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })

  // The engine's own drawing, beneath the plugin, where the band yields.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: ['prompt'] }))
  on('turn.complete', () => ({ text: '' }))

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })

  const pendingFirst = stream.next()
  await clock.advance(700)
  await pendingFirst

  for (let i = 0; i < 8; i++) {
    await stream.next()
  }

  // While the response is still arriving the band shows an estimate.
  const live = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  expect((await live.find({ type: 'Text', text: /tok\/s/ }))?.text).toContain('~')
  await live.unmount()

  const pendingStop = stream.next()
  await clock.advance(2_000)
  await pendingStop
  await stream.next()

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'tps-band', surface, ...BAND })
    const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''

    expect(text).toContain('60.0 tok/s')
    expect(text).toContain('120 tok')
    expect(text).toContain('TTFT 700ms')
    expect(text).not.toContain('~')

    await ui.unmount()
  }

  // The reading stays up after the turn, then clears.
  await $.turn.complete({ answer: '', durationMs: 2_700, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(60_000)

  const cleared = await $.ui.mount({ plugin: 'tps-band', surface: 'desktop', ...BAND })
  expect(await cleared.find({ type: 'Text', text: /tok\/s/ })).toBeUndefined()
  await cleared.unmount()
})

test('a survey holds the band', async ($, on) => {
  mock.clock(on, { now: 0 })

  on('turn.step', async function* () {
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return {
      turnId: 't2',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })

  // The engine's own drawing, beneath the plugin, where the band yields.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: ['survey'] }))

  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  await stream.next()
  await stream.next()

  const ui = await $.ui.mount({
    plugin: 'tps-band',
    surface: 'desktop',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })

  expect(await ui.find({ type: 'Text', text: /tok\/s/ })).toBeUndefined()
  await ui.unmount()
})
