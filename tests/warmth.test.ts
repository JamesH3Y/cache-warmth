import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 400000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5', ...over,
})

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (args: string): CommandRunInput => ({
  command: 'warmth', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

type ForkAnswer = ModelForkResult | { read: number; write: number }

const warm: ForkAnswer = { read: 400000, write: 0 }
const busy: ForkAnswer = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }

const PLAN = [{ kind: 'five_hour', percentUsed: 12 }]

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
// `isPaneOpen` stands for the sidebar panel 0.2 opened, still up across the reload to 0.3.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Record<string, unknown>; rateLimits?: typeof PLAN; isPaneOpen?: boolean } = {}) {
  const pane = { isOpen: opts.isPaneOpen ?? false }
  on('ui.panes', () => ({
    value: pane.isOpen ? [{ id: 'cache-warmth', title: 'Cache warmth', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.close', () => {
    pane.isOpen = false
    return { value: undefined }
  })
  const store = new Map(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 400000 }, rateLimits: opts.rateLimits ?? PLAN } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  // Transcript lines the model never reads; the debug log's are left out.
  const logs: string[] = []
  on('ui.log', ($, e) => { if (e.to !== 'debug') logs.push(e.text); return { value: undefined } })
  const draws = { count: 0 }
  on('ui.render', ($, e) => { draws.count++; return $.ui.resolve(e).Text({ children: [''] }) })
  on('model.fork', () => {
    forks.push(forks.length)
    const a = forkAnswers.shift() ?? warm
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, toasts, store, draws, pane, logs }
}

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('keep-warm', () => {
  test('a reply turns keep-warm on by itself and a ping lands every 50 minutes', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('keep-warm ends three hours after the last reply, so a forgotten session stops on its own', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(6 * HOUR)
    // Pings at 50, 100 and 150 minutes; the next would come at 200, after the window closed at 180.
    expect(w.forks.length).toBe(3)
  })

  test('a ping that reads nothing pauses keep-warm with the reason, and the next reply starts it again', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 400000 }])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.toasts.join('\n')).toMatch(/keep-warm paused, the ping read 0 and wrote 400k tokens/)
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a busy API is retried a minute later', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(2)
    expect(w.toasts).toEqual([])
  })

  test('/warmth off stops the pings and is remembered for later sessions', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('off'))
    expect(w.logs.at(-1)).toMatch(/Keep-warm is off/)
    await clock.advance(3 * HOUR)
    expect(w.forks.length).toBe(0)
    expect(w.store.get('enabled')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('a stored off keeps a new session from pinging until /warmth on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: { enabled: false } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await $.command.run(run('on'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window length is remembered and used from the next reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.command.run(run('90m'))
    expect(w.store.get('window')).toBe(90 * MIN)
    await $.turn.complete(turn())
    await clock.advance(4 * HOUR)
    // One ping at 50 minutes; the next would come at 100, after the 90-minute window.
    expect(w.forks.length).toBe(1)
  })

  test('with no usage limits reported the cache is read as 5 minutes and nothing pings', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { rateLimits: [] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    await $.command.run(run('status'))
    expect(w.logs.at(-1)).toMatch(/lifetime {4}5 minutes/)
  })

  test('/warmth ttl 1h lets an API session with an hour cache keep warm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { rateLimits: [] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('ttl 1h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('compaction holds the pings until the next reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/warmth every 1m pings once a minute for ten minutes, then goes back to every 50', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('every 1m'))
    expect(w.logs.at(-1)).toMatch(/for the next 10m/)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(9)
    // Back to 50: the next ping comes 50 minutes after the last test ping, at minute 59.
    await clock.advance(48 * MIN)
    expect(w.forks.length).toBe(9)
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(10)
  })

  test('a reply ends a test\'s one-minute pings', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('every 1m'))
    await $.turn.complete(turn())
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(1)
  })

  test('the test waits for a warm cache rather than arming a knob a reply would undo', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.command.run(run('every 1m'))
    expect(w.logs.at(-1)).toMatch(/send a message first/)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(0)
  })

  test('every /warmth reply is shown to the person and none reaches the model', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    for (const args of ['', 'status', 'on', '6h', 'ttl auto', 'every 1m', 'every 99m', 'nonsense', 'off']) {
      const before = w.logs.length
      const reply = await $.command.run(run(args))
      expect(reply.text).toBeUndefined()
      expect(reply.context).toBeUndefined()
      expect(w.logs.length).toBe(before + 1)
    }
    expect(w.logs[0]).toMatch(/^cache {7}warm, cools in 1h00m/)
  })

  test('a subagent turn neither opens a window nor moves the clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn({ agentId: 'worker' }))
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})

describe('the meter above the prompt', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reads not started, warm, cooling then cold on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, [], { store: { enabled: false } })
      await $.session.start({ ...session, surface })
      const ui = await $.ui.mount({ plugin: 'cache-warmth', surface, component: 'AbovePrompt', props: bandProps })
      const line = async () => (await ui.find({ type: 'Text', text: /^cache / }))?.text ?? ''
      expect(await line()).toMatch(/not started · the meter starts with the first reply/)
      await $.turn.complete(turn())
      expect(await line()).toMatch(/^cache ━{12} warm 1h00m · keep-warm off$/)
      await clock.advance(30 * MIN)
      expect(await line()).toMatch(/^cache ━{6}─{6} warm 30m · keep-warm off$/)
      await clock.advance(22 * MIN)
      expect(await line()).toMatch(/^cache ━{2}─{10} cooling 8m · a message now keeps it warm · keep-warm off$/)
      await clock.advance(10 * MIN)
      expect(await line()).toMatch(/^cache ─{12} cold · next message re-writes 400k tokens \(~\$3\.20\) · keep-warm off$/)
      await ui.unmount()
    })
  }

  test('only the time left is bold and coloured; the spent part and the details stay dim', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { store: { enabled: false } })
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'cache-warmth', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    const lit = await ui.find({ type: 'Text', text: /^━+$/ })
    expect(lit?.props).toEqual(expect.objectContaining({ color: 'success', bold: true }))
    const spent = await ui.find({ type: 'Text', text: /^─+$/ })
    expect(spent?.props).toEqual(expect.objectContaining({ dimColor: true }))
    const label = await ui.find({ type: 'Text', text: /^warm 30m$/ })
    expect(label?.props.bold).toBeUndefined()
    await ui.unmount()
  })

  test('redraws once a minute with no other event', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: { enabled: false } })
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'cache-warmth', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.settle()
    const before = w.draws.count
    await clock.advance(3 * MIN)
    expect(w.draws.count).toBeGreaterThanOrEqual(before + 3)
    await ui.unmount()
  })

  test('shows the keep-warm countdown and the last ping on one line', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'cache-warmth', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^cache / }))?.text).toMatch(/warm 1h00m · keeping warm 3h00m · ping in 50m$/)
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^cache / }))?.text).toMatch(/warm 1h00m · keeping warm 2h10m · ping in 50m · last ping \$0\.08$/)
    await ui.unmount()
  })

  test('/clear sets the meter back to not started and stops the pings', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const ui = await $.ui.mount({ plugin: 'cache-warmth', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    expect((await ui.find({ type: 'Text', text: /^cache / }))?.text).toMatch(/not started/)
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    await ui.unmount()
  })

  test('a surface with no band gets the meter as a status line', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'vscode' })
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^cache ━{12} warm 1h00m · keeping warm 3h00m · ping in 50m$/)
  })

  test('the sidebar panel an earlier version opened is closed, and its remembered close forgotten', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { store: { pane: false }, isPaneOpen: true })
    await $.session.start(session)
    expect(w.pane.isOpen).toBe(false)
    expect(w.store.has('pane')).toBe(false)
  })
})
