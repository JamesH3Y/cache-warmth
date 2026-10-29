/** What the last keep-warm ping read back. */
export type PingRecord = { at: number; read: number; write: number; usd: number | null }

/** What the meter draws from, kept in $.state so a reload of the mod does not blank it. */
export type Snapshot = {
  lastRequestAt: number
  ttlMs: number
  ttlSource: 'plan' | 'no-plan' | 'set' | null
  ctx: number
  model: string | null
  isCompacted: boolean
  isEnabled: boolean
  windowMs: number
  deadline: number
  every: number
  stopped: string | null
  isWaitingForTurn: boolean
  retries: number
  last: PingRecord | null
  pings: number
  pingUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-warmth': { snap: Snapshot | null }
  }
}
