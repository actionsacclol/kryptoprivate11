# Auto-callout — 2026-09-22

Post a pump.fun callout on the coins you buy, from the account belonging to the
wallet that bought. Automation → Auto-callout. Off by default.

## The API, all of it observed

Nothing here was guessed. Probing found the read side and the eligibility
preflight; the create call came from watching a real callout being posted.

```
POST https://frontend-api-v3.pump.fun/callout/create   →  201 Created

{ "coinMint": "<mint>", "thesis": "<text>",
  "chainId": 1399811149, "version": 2 }
```

**`coinMint`, not `mint`.** That is the field nobody would have guessed, and it
is why the body was left unimplemented rather than filled with a plausible
shape: a wrong field name is a 400 on every buy that reads as a bug in our
posting rather than in the guess.

**Auth is a COOKIE, not a bearer token.** The preflight answers
`access-control-allow-headers: content-type`, so pump's own browser client
*cannot* send an `Authorization` header — the session rides on the `auth_token`
cookie, with `access-control-allow-credentials: true`. That is a browser
restriction, not a server one. This app is not a browser, so it sends the
cookie under the name their login sets, a bearer header beside it, and their
origin. Whichever the guard reads is present. Assuming bearer-only would have
been a 401 on every post.

**Verified without posting anything.** A throwaway account holding nothing was
sent the real request and came back:

```
403 {"error":"INSUFFICIENT_BALANCE",
     "message":"Insufficient token balance — minimum $1 required to post"}
```

A balance refusal rather than a 400 or a 401 is what proves the route, the auth
and the body shape were all accepted well enough to reach pump's own balance
check. It also confirms the floor in their own words.

## What pump allows

Measured, not assumed:

| Rule | Value |
|---|---|
| Position required | $1 of the coin |
| Attempts per coin | 3 |
| Cooldown | exposed in seconds, length unmeasured |
| Daily / lifetime cap | none — lifetime counts run to 203, median 64 |

The preflight at `/callout/eligibility/{mint}` is asked **every time** and its
answer obeyed. It knows things this app does not: whether the position is still
held, how many attempts on that coin are left, and whether a cooldown is
running. Nothing here invents a limit pump does not have, and nothing works
around one it does. An unreadable field reads as unknown rather than as a
permissive default.

## What it does

On a confirmed buy, if switched on and the buying wallet has a pump account,
one of your lines is chosen at random and posted. The buying wallet is the one
holding the coin, so it is the only account pump would accept and the honest
author of the call.

**The text is a list**, one variant per line, a random one per coin. The same
sentence on every call is a signature, and a caller whose calls all read
identically is one people mute. It is not a way to look like several people —
every call carries the same wallet and pump shows the caller's position beside
it.

**An optional minimum buy size** skips scratch trades. Not a pump rule: the
payout tracks the volume a call brings in, so calling everything spends the
standing that earns it.

## Failure behaviour

A refused callout **logs and stops**. It does not retry, and it does not toast —
being refused is ordinary at three per coin with a cooldown, and a popup on
every buy would be noise. The post is fire-and-forget with its errors caught,
so a social post failing can never read as a failed trade.

## The watermark

Every callout posted from here ends `· via krypt.cc/tools/krypto`, leaving 172
characters for the user's own line.

It is **disclosure before it is promotion**. A callout posted the instant a buy
confirms is not the same thing as one someone sat down and wrote, and a reader
deciding whether to trade on it should know which they are looking at. That it
also names the tool is a side effect rather than the point.

It is applied inside `calloutBody`, on the way out, so no caller can post an
unmarked one; it is idempotent, so the form showing it and main applying it
never double it; and `thesesOf` cuts each line to the budget rather than the raw
200, or a full line would lose its tail to the cap instead of the mark.

## One door

Three things post: auto-callout on a buy, a script calling `bot.callout`, and
the test button. All three go through `postNow` in
`electron/engine/autoCallout.ts`, which is the only place the create call is
built. So the preflight is asked, its refusal is obeyed, and the watermark is
applied on every path — a second place that built the request would be a second
place to forget one of those. A test asserts the create call appears once and
that no other main-process file mentions the route.

## Posting one by hand

Auto-callout → **Post one now**: pick an account, a token that wallet holds, and
the words. It posts one real, public callout and shows exactly what came back,
including a refusal in pump's own words — a refusal is the useful half of the
test, because it proves the preflight is being asked and obeyed.

This exists to prove the whole chain in one press: sign-in, eligibility, the
create call, the watermark. Nothing schedules it and nothing retries it.

The renderer names a wallet, a mint and the words. It cannot name a host, a
route or a body: those are built in main, which is also where the watermark is
applied, so this path cannot post an unmarked call either.

## From a script

```js
await bot.callout(mint, 'text', address?)
await bot.pumpAccounts()   // [{address, username, active}]
```

Solana only, and it costs an action against the script's budget like any other
spend. Leave the text out and it uses a random line from the Auto-callout
settings.

The third argument names **which of your own accounts posts**. It is matched
against the addresses of sessions this app holds, so a script can pick any
wallet you have signed in and can name nothing else; an address with no session
is **refused** rather than quietly swapped for the active wallet, which would
post from the wrong account under your name. Left out, the active trading
wallet posts.

`bot.pumpAccounts()` is how a script finds them — addresses and usernames only,
never a session token.

**The ceiling.** One script may call one coin from at most **five** accounts,
once each. That is the same five that limits wallets per coin in
`docs/multi-wallet-2026-09-22.md`, and it is what keeps "a script may name an
account" from becoming "one buy fans out into N posts". It is held in memory,
so a restart clears it and pump's own *you have already called this coin* is
what catches a repeat after that.

**A paper script posts nothing** and says what it would have said. A callout is
public in whichever mode the script is in, so there is no paper version of it to
run; the log line is the rehearsal.

## The NOBUY proof of concept

`docs/scripts/nobuy-callout.js`. The point is to watch the whole chain work on a
coin nobody should trade — and the least persuasive possible thing to put under
a coin is a line telling people not to buy it.

The script does the callouts only. Launching and buying are the pages that
already do them, and both now feed it:

1. **Wallet Lab → Copier** — switch the group on, set **Random range** with the
   amount each wallet should spend (0.006–0.012 SOL is the default, roughly a
   couple of dollars at recent prices), and leave the gap randomised.
2. **Wallet → pump.fun accounts** — sign in each wallet that will call out.
3. **Launch page** — create the coin from the main wallet. A dev buy is
   required, so the launch is billed like any other buy — and it now counts as
   a manual buy for the Copier, so the group follows it into the coin, one
   wallet at a time, each drawing its own amount.
4. **Scripts** — paste the script, set the mint, chain Solana, mode **Live**.
   It posts from one account every 30 seconds, treating pump's *no position*
   refusal as the signal that a wallet's buy has not landed yet.

So the only thing done by hand is pressing Launch and pasting a mint.

One callout per tick rather than a loop, because a callout is a preflight plus a
post and five in one handler can outlast the 30 s a handler is killed at.

## Updating a callout — replies, which re-bump it

A callout is **one per coin per account**. The eligibility preflight says so
directly: `postableAccounts[0].existingCalloutId` comes back with the uuid of
the call that already exists, the same one `highlight_callout=` carries in a
pump.fun link.

No edit route is known. What their client does instead, OBSERVED 2026-09-22:

```
POST frontend-api-v3.pump.fun/callout/<uuid>/replies  →  201 Created
{ "content": "Working on some insane tek right now. krypto never dies" }   69 bytes
```

Rate limit `x-ratelimit-limit: 10`, `x-ratelimit-reset: 60` — tighter than the
profile's 30/120, which is why replies go one at a time rather than in a loop.

**A reply RE-BUMPS the callout.** That is the point of sending one, and it is
why this exists: a call made at launch goes quiet, and a reply brings it back
up. It appends rather than rewriting, so the record of what was said when
survives — which is the better shape regardless, since an edit would rewrite a
statement other people have already traded against.

The bump is also what would make an automated reply loop tempting. The only
things pacing one are pump's reply cooldown, their 10-per-60s limit, and the
calling script's own action budget. Nothing in the app sends a reply of its own
accord.

Replies carry the watermark for the same reason callouts do — a reply can be
read on its own, away from the call it hangs under.

**The id never comes from a caller.** It is read from pump's own preflight, and
`looksLikeCalloutId` requires a plain UUID before it becomes a path segment —
it is the only caller-adjacent part of any URL in that module.

### The bug this uncovered

`cooldownRemainingSeconds` is read from `preflight.**reply**`, and it was being
used to refuse a **create**. A coin nobody had ever called could therefore be
"cooling down", and the callout was skipped silently. Once replies turned out
to be a real, separate action the mis-wiring was obvious: the cooldown gates
replies now, in `replyRefusal`.

If that reading is wrong and pump does apply it to creates, the cost is one
refusal from their server — reported in their words, not retried. That is the
right way round for a guess this size.

### Where it is

- **Auto-callout → Post one now** has a *New callout* / *Reply to my callout*
  switch. Which one is happening is visible before the button is pressed
  rather than discovered from a refusal.
- `await bot.calloutReply(mint, 'text', address?)` in scripts, with the same
  account argument as `bot.callout`. **Not** capped by the five-accounts-per-coin
  ceiling: that limits how many of your accounts may *call* a coin, and a reply
  adds no new caller. pump's cooldown is what paces them.
- Auto-callout on a buy does **not** reply either. Buying more of a coin you
  already called is not a reason to say something new about it under your name.

## What was deliberately not built: follower callouts

Auto-callout fires on the **active wallet's** buys only. The Copier's follower
buys go through a different path and post nothing, so five wallets in a group
produce one callout, not five.

That was a decision, not an oversight. One wallet calling a coin it holds is a
person with a position saying so. Five related wallets calling the same coin
minutes apart is the shape of manufactured consensus — the sharpest version of
what commit `b46b569` removed features over, and the thing the spacing rules in
`docs/multi-wallet-2026-09-22.md` exist to avoid.

The script method is what stays reachable instead. A script *can* post from
several of your accounts — that is deliberate, and it is what makes a group of
wallets testable — but the difference from a switch is real:

- it is code somebody wrote and enabled, not a checkbox on a trading page;
- it is one call per statement, against the script's own action budget;
- five accounts per coin, once each, is the ceiling;
- and every post carries the watermark, so five of them read as one automated
  operator rather than five independent people.

That last point is the honest limit of the mitigation. Five marked calls are
still five calls. The reason not to wire this into the buy path is that nobody
would have to decide to do it.

## Not covered

- **Solana only.** `chainId` names the chain and the hook sits on the Solana buy
  path. An EVM buy would need that chain's id and its own wiring.
- **The cooldown's length** is unmeasured — the field reads zero on an account
  that has never posted.
- **Posting is still unverified end to end.** The shape is verified by the
  balance refusal above; a successful post needs a funded wallet and is a real
  public callout, so it is left for a person to do deliberately — that is what
  **Post one now** is for. Until someone presses it, "201 Created" is inferred
  from their client, not observed from ours.

## Pinned by

`test/autocallout.test.mjs` — 15 checks covering the body shape, the preflight
refusals, the cookie auth, the random line choice, the watermark (applied once,
on the way out, with room left for it), the single door every post goes through,
the script method's Solana/paper/budget gates, which account posts, and that a
failed callout never surfaces as a failed trade.
