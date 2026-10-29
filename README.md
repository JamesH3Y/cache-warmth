# cache-warmth

A warmth meter for Claude Code's prompt cache, and keep-warm that turns itself on after every reply.

Based on [Cache Tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT). The ping engine, its retry rules and the price rows are his. What changes here:

- **Keep-warm needs no command.** Cache Tax waits for `/keepwarm` before a break. A break you never planned, like drifting off while Claude works, is the one that costs. Here every reply that reaches the cache opens a 3 hour window, and a ping every 50 idle minutes holds the cache inside it.
- **The meter is always there, and quiet.** One dim line above the prompt: a thin countdown line (one stroke per 5 minutes of the hour, coloured for the time left), the state, the keep-warm countdown and the last ping's cost. It redraws every minute, locally, at no token cost.
- **Nothing refuses a send.** When the cache is cold, the meter shows what the next message will re-write and roughly what it costs. That's all.

```
cache ━━━━━━━───── warm 34m · keeping warm 2h41m · ping in 16m · last ping $0.08
cache ━━────────── cooling 6m · a message now keeps it warm · keep-warm off
cache ──────────── cold · next message re-writes 412k tokens (~$3.30) · keep-warm off
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-warmth --marketplace JamesH3Y/cache-warmth
```

Answer `y` to add the marketplace, then choose a scope: user loads it in every session and repo.

From a shell:

```sh
claude plugin install cache-warmth --marketplace JamesH3Y/cache-warmth
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `JamesH3Y/cache-warmth`, then Add plugin.

Built and tested on Claude Code 2.1.309. Mods need 2.1.287 or later.

## Commands

Replies show as a dim line in the transcript that the model never reads, so checking costs no tokens.

    /warmth              the status card: state, cache lifetime, context, cold cost, pings so far
    /warmth off          stop keep-warm, here and in later sessions (the meter stays)
    /warmth on           bring it back
    /warmth 6h           keep warm this long after each reply (10m to 24h, remembered; default 3h)
    /warmth ttl 1h       say the cache lives an hour (also 5m, or auto to detect it)
    /warmth every 1m     ping every minute for ten minutes, to watch it work, then back to every 50

## Costs and limits

- Each ping is a cache read of the whole context plus a short answer (at a high effort setting the model may think first; the shown cost counts that). On Opus 5.5 at 400k tokens that is about $0.08 at API prices, against about $3.20 to re-write the same cache once it has cooled. On a subscription the dollars are a yardstick: pings draw on your usage limits, and how a cache read weighs against them is not documented.
- A ping every 50 minutes only helps a cache that lives an hour. Subscriptions get that by default. The mod reads the cache as 5 minutes when no usage limits are reported (API billing) and sends no pings; `/warmth ttl 1h` overrides that if you set `promptCacheTtl` to `1h`.
- The meter is an estimate from the mod's own clock, not a check against the server. A ping's readback is the one real check: if a ping reads nothing, or writes a tenth or more of what it read, keep-warm pauses and says why. Your next message starts it again.
- Claude Code has to stay open and the machine awake. Timers do not run while the laptop sleeps, and a ping that would land on a cold cache is never sent.
- Each open session keeps itself warm. Several idle sessions each ping.
- Nothing pings forever. Only your replies open the window again; pings never do. A session left open and forgotten gets three pings at the default 3 hour window, then stops, and its cache cools an hour later.
