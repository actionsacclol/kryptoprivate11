# The AI connection (MCP), 2026-09-21

User: "would it be possible to add an mcp tool / connection so people can
directly connect to our bot with ai but not reverse it or anything and not
remove fees, but have a bot run through our system" — then: "so lets build
the mcp then".

Built. This is what it is, why it is safe, and what it deliberately cannot do.

## 1. The rule the whole thing rests on

**The tools take intents, never transactions.**

An agent may say "buy 0.1 SOL of this mint". It may not hand the app a signed
transaction, an instruction list, a fee number, a treasury address, an RPC URL
or a settings patch. Every tool argument is listed in `shared/mcp.ts`, every
schema says `additionalProperties: false`, and `mcpTools.ts` refuses an
unknown field rather than ignoring it.

So the fee cannot be removed through this door, for a structural reason rather
than an obfuscation one: `buy_token` reaches `engine.testTrade` and
`sell_token` reaches `engine.manualSell` — the same two methods the app's own
buttons reach — and both end in `liveSigner.ts`, which injects the Krypt fee,
checks the treasury pin, applies the $KRYPTO holder waiver and runs the
signer's outflow policy. There is no path from an MCP tool to a signature that
skips any of it, because there is no path from an MCP tool to a signature at
all. It asks; the app builds.

That is also the answer to "reverse it". The tool schemas ARE the whole API
surface. They expose no builder internals, no account layouts, no key
material, no provider URLs, no settings. An agent learns what a user with the
app open already knows.

The binary is still on the user's machine, and a determined person can still
patch it — that is what the five hardening layers are for, and MCP neither
helps nor hurts that. What MCP must not become is a *supported* way around the
fee, and it is not one.

## 2. What is not exposed, on purpose

No wallet generation, import or export. No withdrawals or transfers. No
bridging. No token launching. No Wallet Lab fan-out. No settings writes of any
kind — especially anything touching fees, the treasury, referrals or RPC
endpoints. No arming of a copy config: reading them is fine, but arming one
starts unattended spending and stays a decision a person makes in front of the
app. No raw RPC.

## 3. The access ladder

`off` → `read` → `paper` → `live`, in `shared/mcp.ts`. Ships **off and
read-only with no token**.

- `read` — the nine read tools. Nothing can change.
- `paper` — the trade tools appear and are simulated into the paper book.
  Nothing is bought and no fee is paid.
- `live` — real funds, within the budget below.

Three things make the ladder real rather than cosmetic:

1. **It gates answers, not just the advertised list.** `toolsFor` decides what
   `tools/list` shows; `toolAllowed` decides what `tools/call` answers. A
   client that calls a tool it was never shown is refused with a reason.
2. **The level is read per REQUEST.** Switching the connection off in the app
   stops the next call, not the next connection.
3. **The tier is checked before the arguments are.** A read-only connection
   that misspells a field of `buy_token` is told it is read-only, not told
   what `buy_token`'s fields are.

Moving to `live` is its own IPC channel (`mcp:setAccess`), not a settings
patch — the same reasoning that keeps `execution.liveEnabled` off the patch
path — and it is confirmed in the app with the words "Let an AI spend real
funds?". `mcp.token` and `mcp.access` are both in `OWNED_ELSEWHERE`, so no
settings patch can reach either.

## 4. The budget

Mirrors `BotTradePolicy` (shared/botTrading.ts), because the risk is the same
shape: an automated caller that can spend needs the user's ceiling, not its
own. Defaults: **0.1 per buy, 0.5 an hour, 4 trades a minute.**

- The value caps bind **live only**. A paper record built under tighter limits
  than the live one would measure a strategy nobody intends to run.
- The rate limit binds **every** level.
- **Sells are never value-capped.** The worst an unwanted sell can do is put
  the user's own funds back in the user's own wallet, and being able to get
  out is the point of letting an agent trade at all.
- A **limit buy** meets the buy caps, because it commits funds when it fires.
  A stop loss does not.
- The attempt is recorded **before** the app is asked, so two calls in flight
  cannot both read an allowance neither has spent — the reservation rule copy
  trading learned the hard way (docs/copy-trade-audit-2026-09-13.md). Pinned
  by a concurrent-buy case in `test/mcptools.test.mjs`.
- Changing the access level clears the counters: a switch to live must not
  inherit an hour of paper "spending" that cost nothing.

## 5. The door

`electron/system/mcpServer.ts`, hand-written rather than pulled from the SDK —
the app is bytecode-hardened and electron-pinned, and a new dependency in the
process that holds the signing key is a new thing to trust. The subset a
tools-only server needs is six methods.

| guard | what it does |
|---|---|
| bind | `127.0.0.1` explicitly. No setting makes it listen anywhere else. |
| auth | `Authorization: Bearer <token>`, 32 random bytes, compared in constant time over a digest so neither value nor length leaks. |
| Origin | A present-and-not-loopback `Origin` is **403**, as the spec requires by name. Without it any web page the user has open could drive their wallet — the DNS-rebinding hole. |
| body | 256 KB, and an oversized body is read-and-discarded so the client gets a 413 rather than a dropped socket. |
| path | One path (`/mcp`). No route reads a file, proxies a URL or reflects input. |
| off | `access === 'off'` answers 503 whatever the token says. |

## 6. Two protocol eras, one endpoint

The research (three docs sets fetched 2026-09-21) turned up the thing that
would otherwise have shipped broken: **the current protocol version is
`2026-07-28`, and it deleted the handshake.** No `initialize`, no
`notifications/initialized`, no `Mcp-Session-Id`, no GET stream. Every request
carries its own version in `_meta`, repeats its method and target in headers
so a proxy can route without parsing a body, and discovery is
`server/discover`.

Today's clients still send the legacy handshake. The spec blesses serving both
on one endpoint, and this does. The era of a request is read off the request
itself — does its body carry `_meta["io.modelcontextprotocol/protocolVersion"]`
— never configured.

| | legacy (≤ 2025-11-25) | modern (2026-07-28) |
|---|---|---|
| open | `initialize`, version negotiated | none |
| identity | `Mcp-Session-Id` minted and echoed | no session; the header is ignored |
| discovery | `initialize` result | `server/discover` |
| headers | none required | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` must match the body |
| results | plain | carry `resultType: "complete"` |
| unknown method | `-32601` | `-32601` **and HTTP 404** |
| bad version | answer with ours | `-32022` + the supported list |
| missing capabilities | n/a | `-32021` |

Error division, as the spec draws it and as the code follows: a tool that
**exists but is switched off** is an error RESULT (`isError: true`) the model
can read and work around; a tool that **does not exist** is a protocol error
(`-32602`), because no retry fixes it; a **throw** is `-32603` with the
message swallowed.

## 7. The tools

Thirteen read, four trade. Read first in the catalogue, so an agent listing
them meets the ways of looking before the ways of spending.

`get_wallet` · `get_positions` · `get_token` · `find_tokens` ·
`get_wallet_scores` · `get_wallet_record` · `get_copy_configs` · `get_orders` ·
`get_trade_history` · `get_chart` · `get_token_links` · `get_runner_alerts` ·
`get_callouts` — then `buy_token` · `sell_token` · `place_order` ·
`cancel_orders`.

**Three chains, where the app has three.** Trades, positions, token lookups,
the Discover lists, the Scout tools and the runner alerts all take a `chain`
(default Solana). Four do not, because the thing behind them is Solana only:
advanced orders, the chart's tape, the Links panel and pump.fun's callouts.
Each says so in its own description and **refuses a `chain` argument outright**
rather than accepting one it cannot honour — `additionalProperties: false`
plus the `unexpected` check make that a refusal with a reason, not a silent
ignore.

### How EVM trading got wired

`engine.hostBuy` / `engine.hostSell` are now public, and they are the pair the
user-scripting host already used — Robinhood Chain and BNB route onto their
own rails *before* the Solana path, because a caller on an EVM chain whose buy
fell through to the Solana builder would spend SOL on another chain's address.
The MCP host calls the same two methods, so there is **one implementation with
two transports** instead of two that drift. Extracting them was the point: for
a day there were two copies of that routing rule, which is exactly how one
gets fixed and the other does not. `engine.linksFor` came out the same way.

Address shapes are checked per chain — base58 for Solana, `0x…` for the EVM
rails, lower-cased on the way in as the rest of the app keys them. An EVM
address sent to Solana, or the reverse, is refused before anything is spent.

### The four readers added the same day

| tool | source | the caveat it carries |
|---|---|---|
| `get_chart` | `market.candlesFast` — the app's own tape merged with its providers | an empty answer says the coin may have no history, rather than implying a flat price |
| `get_token_links` | `engine.linksFor` — cached facts only, no fetch | a null is something nobody has looked at; the app never visits a link on its own, so absence is not evidence |
| `get_runner_alerts` | `engine.runnersSnapshot` and `evmScanner.flagged` | says in the answer that most flagged launches still do not graduate, and that nothing was bought |
| `get_callouts` | pump.fun's public `/home-feed` | labels each caller's position as *their* claim, not something this app verified; null when pump is not answering, which is different from an empty feed |

**The honesty rules apply to a model reader too.** The server's `instructions`
tell the agent that paper and live are different worlds, that a null means
"the app does not know" rather than zero, and that nothing here predicts.
`get_wallet_scores` repeats that the Copy score ranks least-bad to follow and
is not an edge. `get_trade_history` says the basis is on-chain, so the figures
already include fees. Every read tool's answer carries the caveat its numbers
need, in the sentence above the data, because a model that reads only the JSON
will quote the number without it.

## 8. Connecting

Settings → AI connection: switch it on (a token is minted), choose a level,
copy the line.

```
claude mcp add --transport http krypto-terminal http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

Or the same as JSON, for a client that takes a config file. Both are built by
`mcpAddCommand` / `mcpJsonConfig` so the panel, the guide and the test cannot
disagree. A `url` with no `"type"` is a configuration error in Claude Code, so
the JSON form always carries `"type": "http"`.

## 9. Verified

- `test/mcp.test.mjs` (5) — the catalogue is well formed; **no tool takes a
  transaction, fee, treasury, endpoint or setting, and none is a withdrawal or
  a launch**; the ladder; the budget arithmetic; the connect string.
- `test/mcpserver.test.mjs` (8) — against a real socket on an ephemeral port:
  the six guards, the access switch taking effect per request, both eras end
  to end, the batch rules, and that stopping closes the port.
- `test/mcptools.test.mjs` (6) — arguments refused rather than coerced, an
  unknown field refused, the tier checked before the arguments, paper passed
  all the way down, the caps, the reservation under two concurrent buys.

**Verified against a real client, and it found two bugs.** Claude Code 2.1.278
was pointed at the running app with `claude mcp add`. It refused the server:

> tools fetch failed — Invalid result for tools/list: missing required
> resultType — servers implementing protocol revision 2026-07-28 MUST include it

A throwaway logging server was put on another port and the client aimed at it,
which showed what it really sends:

```json
{"jsonrpc":"2.0","id":0,"method":"tools/list",
 "params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
   "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.278"},
   "io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{}}}}}
```

Two things were wrong, and neither was visible against frames written from the
spec prose:

1. **`_meta` travels inside `params`, not at the top level of the JSON-RPC
   object.** Reading it from the top made every modern request look legacy, so
   `tools/list` came back with no `resultType` and the client rejected the
   whole server. `eraOf` now reads `params._meta` first and the top level as a
   fallback.
2. **A modern `tools/list` result MUST carry `ttlMs` (a number) and
   `cacheScope` (`public` | `private`).** The client validates both. Ours
   sends 60 s and `private` — private because the tool set depends on THIS
   connection's access level, so a shared cache could hand a read-only
   connection a live one's list.

Also learned from the capture: the client uses a **string** id
(`"server-discover-probe-1"`), sends `Accept: application/json,
text/event-stream`, and identifies itself in `params._meta`, not `clientInfo`.

After the fix: `claude mcp list` reports **✔ Connected**, and `tools/list`
over the client's exact frame returns the nine read tools with
`resultType: complete · ttlMs: 60000 · cacheScope: private`. The frames are now
pinned verbatim in `test/mcpserver.test.mjs` (case 7), so the next edit that
breaks either one fails in the suite rather than in someone's terminal.

**The lesson worth keeping: a hand-written wire is not verified until a real
client has refused it once.** Nineteen passing checks written from the spec
did not catch either bug.

## 9b. The guide

Guides → AI connection, its own card (it is not a workspace, so it sits beside
"Start here" rather than inside the workspace list). Six steps and five
cautions, in the page's plain-words register. The cautions lead with the two
things a beginner gets wrong: the copied line is a password, and Live means an
AI spending real money with nothing measured to say that works. It then says
plainly what the connection can never do — no withdraw, no transfer, no send,
no settings, no key, no signing.

## 10. What to watch

- **Never add a tool that takes a transaction, a fee, an endpoint or a
  setting.** `test/mcp.test.mjs` fails on the argument name, which is the
  cheapest possible guard, but the rule is the point.
- A new tool must declare its tier, and a trade tier must be gated in
  `mcpTools.call` as well as in the catalogue.
- If a future protocol version arrives, add it to `MCP_SUPPORTED_VERSIONS` and
  check `isModernVersion` still splits the eras correctly — it is a string
  compare on a dated version, which works only while versions stay dated.
