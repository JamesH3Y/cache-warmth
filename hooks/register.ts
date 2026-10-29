import { atom, read, update } from 'claude-code'
import type { Color, CommandRunResult, EngineInterface, Register } from 'claude-code'

import type { PingRecord, Snapshot } from '../types'

// The ping engine (ping, arm, the retry ladder, the in-flight, gen and tick
// guards) and the price rows are ported from Cache Tax by Karan Bansal (MIT,
// see LICENSE). What differs: keep-warm turns itself on after every reply
// instead of waiting for /keepwarm, the meter is always drawn, and nothing
// refuses a send.

const MIN = 60 * 1000
const HOUR = 60 * MIN
const FIVE_MIN = 5 * MIN
const PING_AFTER_MS = 50 * MIN
const MIN_PING_MS = MIN
const MAX_RETRIES = 3
const DEFAULT_WINDOW_MS = 3 * HOUR
const MIN_WINDOW_MS = 10 * MIN
const MAX_WINDOW_MS = 24 * HOUR
// How long the testing knob's short period lasts: a forgotten /warmth every 1m must never ping once a minute for hours.
const TEST_WINDOW_MS = 10 * MIN
const COOLING_MS = 10 * MIN
const TICK_MS = MIN
// Twelve cells of an hour's cache: five minutes each.
const METER_CELLS = 12
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_ENABLED = 'enabled'
const KEY_WINDOW = 'window'
const KEY_TTL = 'ttl'
// 0.2's sidebar panel, retired in 0.3: its id and its remembered close are cleared at the start.
const RETIRED_KEY_PANE = 'pane'

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026, as Cache Tax has them.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling, never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

const SNAP = { plugin: 'cache-warmth', key: 'snap' } as const
const snap = atom(SNAP, null)

type TtlPref = '1h' | '5m' | null
type Timer = { cancel: () => void }

type State = Snapshot & {
  hasBand: boolean
  ttlPref: TtlPref
  transcript: number
  pending: Timer | null
  ticker: Timer | null
  testUntil: number
  retryReason: string
  gen: number
  tick: number
  isInFlight: boolean
}

type Reading = { state: 'unknown' | 'fresh' | 'warm' | 'cooling' | 'cold'; left: number }

function freshState(): State {
  return {
    lastRequestAt: 0, ttlMs: 0, ttlSource: null, ctx: 0, model: null, isCompacted: false, isEnabled: true,
    windowMs: DEFAULT_WINDOW_MS, deadline: 0, every: PING_AFTER_MS, stopped: null, isWaitingForTurn: false,
    retries: 0, last: null, pings: 0, pingUsd: 0,
    hasBand: false, ttlPref: null, transcript: 0, pending: null, ticker: null, testUntil: 0, retryReason: '', gen: 0,
    tick: 0, isInFlight: false,
  }
}

function snapshotOf(s: State): Snapshot {
  return {
    lastRequestAt: s.lastRequestAt, ttlMs: s.ttlMs, ttlSource: s.ttlSource, ctx: s.ctx, model: s.model,
    isCompacted: s.isCompacted, isEnabled: s.isEnabled, windowMs: s.windowMs, deadline: s.deadline, every: s.every,
    stopped: s.stopped, isWaitingForTurn: s.isWaitingForTurn, retries: s.retries, last: s.last, pings: s.pings,
    pingUsd: s.pingUsd,
  }
}

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

/** The write rate the cache's lifetime pays: the rows carry the 1-hour rate (2x base), a 5-minute write is 1.25x base. */
function writeRate(s: Snapshot, price: [number, number, number]): number {
  return s.ttlMs === FIVE_MIN ? price[1] * 0.625 : price[1]
}

function coldUsd(s: Snapshot): number | null {
  const price = priceOf(s.model, s.ctx)
  return price ? s.ctx * writeRate(s, price) / 1e6 : null
}

function warmUsd(s: Snapshot): number | null {
  const price = priceOf(s.model, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

function isCold(s: Snapshot, now: number): boolean {
  return s.lastRequestAt > 0 && !s.isCompacted && s.ttlMs > 0 && now - s.lastRequestAt >= s.ttlMs
}

/** A ping every 50 minutes can only hold a cache that lives an hour. */
function canKeepWarm(s: Snapshot): boolean {
  return s.isEnabled && s.ttlMs === HOUR
}

function readingOf(s: Snapshot, now: number): Reading {
  if (!s.lastRequestAt || !s.ttlMs) return { state: 'unknown', left: 0 }
  if (s.isCompacted) return { state: 'fresh', left: 0 }
  const left = s.lastRequestAt + s.ttlMs - now
  if (left <= 0) return { state: 'cold', left: 0 }
  return { state: left < Math.min(COOLING_MS, s.ttlMs / 4) ? 'cooling' : 'warm', left }
}

/** The meter as a line: a heavy stroke for the time left, a light one for the time spent. */
function meterLineParts(s: Snapshot, reading: Reading): { lit: string; spent: string } {
  const fill = reading.left > 0 ? Math.max(1, Math.ceil(reading.left / s.ttlMs * METER_CELLS)) : 0
  return { lit: '━'.repeat(fill), spent: '─'.repeat(METER_CELLS - fill) }
}

/** The keep-warm part of the meter, or null where there is nothing worth saying. */
function keepWarmText(s: Snapshot, reading: Reading, now: number): string | null {
  if (reading.state === 'unknown') return null
  if (!s.isEnabled) return 'keep-warm off'
  if (s.ttlMs === FIVE_MIN) return '5m cache, too short to keep warm'
  if (s.stopped) return 'keep-warm paused, /warmth for why'
  if (reading.state === 'fresh' || reading.state === 'cold') return null
  if (s.deadline <= now) return 'keep-warm window over'
  if (s.isWaitingForTurn) return 'keep-warm waits for the next reply'
  if (s.retries) return `API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
  const nextPing = s.lastRequestAt + s.every
  if (nextPing > s.deadline) return `keep-warm ends in ${fmtDuration(s.deadline - now)}`
  return `keeping warm ${fmtDuration(s.deadline - now)} · ping in ${fmtDuration(Math.max(0, nextPing - now))}`
}

type Meter = { lit: string; spent: string; label: string; details: string[]; color: Color | undefined }

function meterOf(s: Snapshot, now: number): Meter {
  const reading = readingOf(s, now)
  const details: string[] = []
  let label: string
  let color: Color | undefined
  if (reading.state === 'unknown') {
    label = 'not started'
    details.push('the meter starts with the first reply')
  } else if (reading.state === 'fresh') {
    label = 'fresh'
    details.push('compacted, warms on the next reply')
  } else if (reading.state === 'cold') {
    label = 'cold'
    color = 'error'
    const usd = coldUsd(s)
    if (s.ctx > 0) details.push(`next message re-writes ${fmtTok(s.ctx)} tokens${usd == null ? '' : ` (~${fmtUsd(usd)})`}`)
  } else {
    label = `${reading.state} ${fmtDuration(reading.left)}`
    color = reading.state === 'warm' ? 'success' : 'warning'
    if (reading.state === 'cooling' && !(canKeepWarm(s) && !s.stopped && s.deadline > now)) details.push('a message now keeps it warm')
  }
  const keep = keepWarmText(s, reading, now)
  if (keep) details.push(keep)
  if (s.last && reading.state !== 'unknown') details.push(`last ping ${fmtUsd(s.last.usd)}`)
  return { ...meterLineParts(s, reading), label, details, color }
}

function meterLine(s: Snapshot, now: number): string {
  const m = meterOf(s, now)
  return [`cache ${m.lit}${m.spent} ${m.label}`, ...m.details].join(' · ')
}

function card(s: State, now: number): string {
  const reading = readingOf(s, now)
  const lines: string[] = []
  lines.push(reading.state === 'unknown' ? 'cache       not started, the meter starts with the first reply'
    : reading.state === 'fresh' ? 'cache       fresh after compaction, warms on the next reply'
    : reading.state === 'cold' ? `cache       cold for ${fmtDuration(now - s.lastRequestAt - s.ttlMs)}`
    : `cache       ${reading.state}, cools in ${fmtDuration(reading.left)}`)
  lines.push(s.ttlSource === 'plan' ? 'lifetime    1 hour (usage limits are reported, so this is a subscription)'
    : s.ttlSource === 'no-plan' ? 'lifetime    5 minutes (no usage limits reported, so API billing; /warmth ttl 1h if you set promptCacheTtl to 1h)'
    : s.ttlSource === 'set' ? `lifetime    ${s.ttlMs === HOUR ? '1 hour' : '5 minutes'}, set with /warmth ttl (/warmth ttl auto to detect it)`
    : 'lifetime    not known until the first reply')
  if (s.ctx > 0) {
    lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens on ${s.model ?? 'an unknown model'}`)
    lines.push(`cold cost   ~${fmtUsd(coldUsd(s))} to re-write it once it cools; a warm reply reads it for ~${fmtUsd(warmUsd(s))}`)
  }
  const keep = !s.isEnabled ? 'off (/warmth on to bring it back)'
    : s.ttlMs === FIVE_MIN ? 'on, but a 5-minute cache is too short for a ping every 50 minutes to hold'
    : s.stopped ? `paused, ${s.stopped}. Your next message starts it again`
    : `on, holds the cache ${fmtDuration(s.windowMs)} after each reply with a ping every ${fmtDuration(s.every)} while you are away` +
      (s.deadline > now ? ` (${fmtDuration(s.deadline - now)} left)` : '')
  lines.push(`keep-warm   ${keep}`)
  if (s.pings) {
    const last = s.last ? ` (last read ${fmtTok(s.last.read)}, wrote ${fmtTok(s.last.write)}, ~${fmtUsd(s.last.usd)})` : ''
    lines.push(`pings       ${s.pings} this session, ~${fmtUsd(s.pingUsd)} in all${last}`)
  }
  const price = priceOf(s.model, s.ctx)
  if (price && s.ctx > 0) lines.push(`break-even  one cold re-write costs about the same as ${Math.floor(writeRate(s, price) / price[0])} pings`)
  lines.push('commands    /warmth on | off | 3h (window) | ttl 1h|5m|auto | every 1m (testing)')
  return lines.join('\n')
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Puts a test's short ping period back to 50 minutes once its ten minutes are up; says whether it did. */
function endTestIfDue(s: State, now: number): boolean {
  if (s.every === PING_AFTER_MS || now < s.testUntil) return false
  s.every = PING_AFTER_MS
  return true
}

/** Outdates any ping in flight: /clear, compaction or a stop replaced the state it was sent for. */
function outdate(s: State) {
  s.gen++
}

function markCompacted(s: State) {
  s.isCompacted = true
  s.transcript = 0
  outdate(s)
}

/** /clear or a resume starts another conversation in the same process; nothing measured before it still holds. */
function resetConversation(s: State) {
  s.lastRequestAt = 0
  s.ctx = 0
  s.isCompacted = false
  s.transcript = 0
  s.deadline = 0
  s.stopped = null
  s.isWaitingForTurn = false
  s.retries = 0
  s.last = null
  s.pings = 0
  s.pingUsd = 0
  outdate(s)
  disarm(s)
}

async function publish($: EngineInterface, s: State) {
  const value = snapshotOf(s)
  await update($, snap, () => value)
  if (!s.hasBand) $.ui.status(meterLine(value, await $.clock.now()))
}

/** Shows a /warmth reply as a dim transcript line the model never reads, and answers with no text for it to read. */
function shown($: EngineInterface, text: string): CommandRunResult {
  $.ui.log(text)
  return {}
}

/** Redraws the countdown once a minute, which no event would otherwise do. */
async function refresh($: EngineInterface, s: State) {
  // Always, even where the surface was not known at the start: a band drawn there must not freeze.
  $.ui.invalidate('ui.render')
  if (!s.hasBand) $.ui.status(meterLine(snapshotOf(s), await $.clock.now()))
}

async function detectTtl($: EngineInterface, s: State) {
  if (s.ttlPref) {
    s.ttlMs = s.ttlPref === '1h' ? HOUR : FIVE_MIN
    s.ttlSource = 'set'
    return
  }
  // A subscription's cache lives an hour by default and API billing's five minutes; only a subscription reports usage
  // limits. Once seen they stay seen, since billing does not change mid-session.
  const hasPlan = s.ttlSource === 'plan' || (await $.session.usage()).rateLimits.length > 0
  s.ttlMs = hasPlan ? HOUR : FIVE_MIN
  s.ttlSource = hasPlan ? 'plan' : 'no-plan'
}

async function stop($: EngineInterface, s: State, why: string | null) {
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await publish($, s)
  if (why) $.ui.toast(`cache-warmth: keep-warm paused, ${why}. Your next message starts it again.`, { timeoutMs: 8000 })
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return publish($, s)
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  endTestIfDue(s, now)
  // The window ran its course: nothing went wrong, so nothing is said.
  if (now >= s.deadline) return stop($, s, null)
  // A cold cache still needs the window's end cleaned up, but must never be pinged: that ping would pay the write.
  if (s.lastRequestAt && !s.isCompacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + s.ttlMs - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the meter says so.
    if (s.isWaitingForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  await publish($, s)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (a command, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.isInFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.isInFlight) return
  if (endTestIfDue(s, now)) return arm($, s)
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.isCompacted || s.isWaitingForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + s.ttlMs - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.isInFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.isInFlight = false
  // A stop, /clear or compaction, or a main request that moved the cache clock, replaced what this fork
  // was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed (${sent.err instanceof Error ? sent.err.message : String(sent.err)})`)
  const reply = sent.reply
  if (!reply) return stop($, s, 'the engine did not send the ping')
  if (!reply.isAnswered) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.isWaitingForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping came back empty'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + s.ttlMs - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        await publish($, s)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const isWarm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  const record: PingRecord = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd }
  s.last = record
  s.pings++
  s.pingUsd += usd ?? 0
  if (!isWarm) return stop($, s, `the ping read ${fmtTok(record.read)} and wrote ${fmtTok(record.write)} tokens, so the cache had already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** Opens keep-warm from now when the cache is warm enough to hold; otherwise the next reply opens it. */
async function openWindow($: EngineInterface, s: State, now: number, windowMs = s.windowMs) {
  if (canKeepWarm(s) && s.lastRequestAt && !s.isCompacted && !isCold(s, now)) {
    s.deadline = now + windowMs
    s.stopped = null
  }
  await arm($, s)
}

function armedText(s: State, now: number): string {
  if (s.ttlMs === FIVE_MIN) return 'Keep-warm is on, but this session\'s cache lasts 5 minutes, which a ping every 50 minutes cannot hold. The meter still tracks it. If your cache lasts an hour, /warmth ttl 1h.'
  if (!s.deadline || s.deadline <= now) return `Keep-warm is on. It starts with the next reply and holds the cache ${fmtDuration(s.windowMs)} after each one.`
  return `Keep-warm is on: the cache stays warm ${fmtDuration(s.windowMs)} after each reply, with a ping every ${fmtDuration(s.every)} while you are away.`
}

export const register: Register = on => {
  const s = freshState()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // A host that attaches its surface after the start reports none here; the band is drawn on terminal and desktop alike.
    s.hasBand = e.surface !== 'vscode' && e.surface !== 'mobile'
    // A reload of the mod keeps $.state: the meter and the window pick up where they were.
    const { value: prev } = await $.state.get(SNAP)
    if (prev) Object.assign(s, prev)
    const enabled = await $.store.get(KEY_ENABLED)
    const windowMs = await $.store.get(KEY_WINDOW)
    const ttl = await $.store.get(KEY_TTL)
    s.isEnabled = enabled !== false
    s.windowMs = typeof windowMs === 'number' && windowMs >= MIN_WINDOW_MS && windowMs <= MAX_WINDOW_MS ? windowMs : DEFAULT_WINDOW_MS
    s.ttlPref = ttl === '1h' || ttl === '5m' ? ttl : null
    if (s.ttlPref) await detectTtl($, s)
    if (!s.model) s.model = await $.session.model()
    await $.command.register({
      name: 'warmth',
      description: 'Prompt cache warmth and keep-warm: status, on, off, a window such as 3h, ttl 1h|5m|auto (cache-warmth)',
      argumentHint: '[status | on | off | 3h | ttl 1h|5m|auto | every 1m]',
      immediate: true,
    })
    if (s.hasBand) $.ui.status(undefined)
    if (s.ticker) s.ticker.cancel()
    s.ticker = $.clock.every(TICK_MS, () => { void refresh($, s) })
    if (!canKeepWarm(s)) s.deadline = 0
    await arm($, s)
    // The mod draws no panel since 0.3: one left open by 0.2 across the reload would sit empty.
    try {
      for (const pane of await $.ui.panes()) await $.ui.close({ id: pane.id })
      await $.store.delete(RETIRED_KEY_PANE)
    } catch (err) {
      $.ui.log(`cache-warmth: the retired panel was not closed (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      resetConversation(s)
      await publish($, s)
    } else {
      disarm(s)
      if (s.ticker) s.ticker.cancel()
      s.ticker = null
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const value = await read($, snap)
    if (!value) return rest
    const m = meterOf(value, await $.clock.now())
    const { Box, Text } = $.ui.resolve(e)
    // Kept quiet: everything dim but the time left and the state, which carry the colour.
    const row = Text({ children: [
      Text({ dimColor: true, children: ['cache '] }),
      Text({ color: m.color, dimColor: !m.color, bold: true, children: [m.lit] }),
      Text({ dimColor: true, children: [m.spent] }),
      ' ',
      Text({ color: m.color, dimColor: !m.color, children: [m.label] }),
      Text({ dimColor: true, children: [m.details.map(d => ` · ${d}`).join('')] }),
    ] })
    return Box({ flexDirection: 'column', children: rest == null ? [row] : [rest, row] })
  })

  on('command.run', { command: 'warmth' }, async ($, e) => {
    const words = String(e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    const [first, second] = words
    if (!first || first === 'status') return shown($, card(s, now))
    if (first === 'off') {
      s.isEnabled = false
      s.every = PING_AFTER_MS
      await $.store.set(KEY_ENABLED, false)
      await stop($, s, null)
      return shown($, 'Keep-warm is off, here and in later sessions. The meter stays. /warmth on brings keep-warm back.')
    }
    if (first === 'on') {
      s.isEnabled = true
      s.every = PING_AFTER_MS
      await $.store.delete(KEY_ENABLED)
      await openWindow($, s, now)
      return shown($, armedText(s, now))
    }
    if (first === 'ttl') {
      if (second !== '1h' && second !== '5m' && second !== 'auto') return shown($, '/warmth ttl takes 1h, 5m or auto')
      s.ttlPref = second === 'auto' ? null : second
      if (s.ttlPref) await $.store.set(KEY_TTL, s.ttlPref)
      else await $.store.delete(KEY_TTL)
      if (s.ttlPref || s.lastRequestAt) await detectTtl($, s)
      else {
        s.ttlMs = 0
        s.ttlSource = null
      }
      if (canKeepWarm(s)) await openWindow($, s, now)
      else await stop($, s, null)
      return shown($, card(s, now))
    }
    if (first === 'every') {
      const period = parseDuration(second ?? '')
      // A period of the cache's whole hour or more would fire only once the cache is already cold.
      if (period == null || period < MIN_PING_MS || period >= HOUR) return shown($, 'every takes a period from 1m to 59m, for testing')
      if (!canKeepWarm(s) || !s.lastRequestAt || s.isCompacted || isCold(s, now)) {
        return shown($, 'The test needs a warm cache with keep-warm on: send a message first, then /warmth every 1m.')
      }
      s.every = period
      s.testUntil = now + TEST_WINDOW_MS
      await openWindow($, s, now)
      return shown($, `Pinging every ${fmtDuration(period)} for the next ${fmtDuration(TEST_WINDOW_MS)} to test it, then back to every 50m. Your next message or /warmth on also puts it back.`)
    }
    const windowMs = parseDuration(first)
    if (windowMs == null || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      return shown($, '/warmth takes status, on, off, a window from 10m to 24h (such as 3h or 90m), ttl 1h|5m|auto, or every 1m')
    }
    s.windowMs = windowMs
    s.isEnabled = true
    await $.store.set(KEY_WINDOW, windowMs)
    await $.store.delete(KEY_ENABLED)
    await openWindow($, s, now)
    return shown($, armedText(s, now))
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      // A compaction leaves a summary where tens of messages were: a request over fewer than half the last one's
      // messages is read as one, whether or not session.compact arrived.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      s.lastRequestAt = await $.clock.now()
      await publish($, s)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.isCompacted = false
    s.isWaitingForTurn = false
    const u = e.usage
    if (u) {
      if (u.model) s.model = u.model
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await detectTtl($, s)
      // Every reply that reached the cache opens the window again from now: no command to remember before a break.
      // It also ends a test's one-minute pings, so the knob cannot outlive the test.
      if (canKeepWarm(s)) {
        s.deadline = now + s.windowMs
        s.every = PING_AFTER_MS
        s.stopped = null
      }
    }
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      s.ctx = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
