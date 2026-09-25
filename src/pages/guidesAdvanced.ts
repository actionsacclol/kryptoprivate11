// Advanced guides — the power-user twin of every card on the Guides page
// (2026-09-24). The beginner cards say what to press; these say what happens
// underneath: defaults, limits, the order things are tried in, and what a
// number does NOT mean. Every line was read from the code when written; if a
// line and the app disagree, the app is right and the line is a bug.
//
// Keyed by the card id Guides.tsx renders (workspace ids, 'start', and the
// standalone cards). test/guides.test.mjs fails if a card has no entry here.

export interface AdvancedGuide {
  /** What it is under the hood, in two to four sentences. */
  what: string;
  /** A power user's workflow, in order. */
  steps: string[];
  /** Mechanics, defaults and limits, grouped. */
  details: { heading: string; lines: string[] }[];
  /** The sharp edges. */
  careful: string[];
}

export const ADVANCED_GUIDES: Record<string, AdvancedGuide> = {
  start: {
    what: 'Every buy and sell, from any button, goes through one pipeline in the app’s main process: build the unsigned transaction, add the Krypt fee and landing tips, check the fee payer and every program it calls, sign, simulate it against your real wallet, check the loss is within bounds, then broadcast on the enabled lanes until it confirms or its blockhash expires. There is one mode switch (Paper / Live in the top bar). Live means armed AND live execution on; anything else is Paper, and Paper never broadcasts. Live is the default: once a wallet exists and the saved mode is Live, the app arms itself at start-up and whenever a wallet appears.',
    steps: [
      'Settings → Solana RPC: paste a Helius API key, or put your own provider in Execution endpoint (https:// only; if set it wins over the Helius key). Either one handles only the calls that decide a trade: simulate, send, confirm, send-time fee estimates and holder reads. Launch scanning and plain account reads stay on the free endpoints.',
      'On the free Helius plan, leave Helius feed socket off. It bills by bytes. The monthly credit ceiling defaults to 1,000,000 and switches the socket off when it is reached.',
      'Wallet page: create or import the trading wallet and back the key up before funding it. Then set Max SOL / trade (default 0.05) and Slippage % (default 12). Session loss cap and Losses in a row default to 0, which means off.',
      'Execution page → Landing configuration: choose Fee urgency (default competitive), Jito tip percentile (default p75) and Sandwich exposure: Public only, Fast (default) or Private. Check that Jito bundles, Helius Sender (free) and Local transaction builder are on (all three are on by default).',
      'Fund the wallet with SOL you can afford to lose, plus about 0.015 SOL. Every buy keeps that much back so the position can be sold again.',
      'Rehearse on Paper. A paper buy signs and simulates the real transaction against your wallet, which needs at least 0.01 SOL in it. When that cannot run, the fill is modelled from the live price and labelled as modelled.',
      'Switch the top bar to Live. Arming resets the loss-breaker baseline to the current balance and keeps sockets, balance and fee data warm while armed. Any disarm saves Paper as the mode.',
      'Optional: turn on trading hotkeys in Settings, and choose an auto-sell template on the Orders page so each manual buy that lands arms your exit orders.',
    ],
    details: [
      {
        heading: 'RPC endpoints',
        lines: [
          'Defaults: WebSocket wss://api.mainnet-beta.solana.com, one extra socket wss://solana-rpc.publicnode.com, HTTP https://api.mainnet-beta.solana.com, commitment processed.',
          'Extra WebSocket endpoints are raced: they all subscribe at once, duplicates are dropped and the first arrival wins. A single public socket loses about 20% of events under load.',
          'Which endpoint executes trades: the Execution endpoint if one is set, otherwise the one derived from the Helius key, otherwise the HTTP endpoint.',
          'Balance reads and bulk account reads always use the HTTP endpoint, so the paid lane’s rate budget goes to trades.',
          'Standby block feed (publicnode blockSubscribe) is on by default. Its post-graduation version is off by default because it pulls about 3.2 MB/s.',
          'Holder lists and some token-account reads are refused by the free public RPC (HTTP 429); a Helius key enables them.',
        ],
      },
      {
        heading: 'What a trade pays',
        lines: [
          'Krypt charges 0.5% per side, taken in the same transaction. It is halved to 0.25% when the wallets this install holds keys for hold 1,000,000 $KRYPTO, and a referrer’s cut is halved with it.',
          'pump.fun charges 1% on curve trades. PumpSwap fees run from 1.25% down to 0.30% depending on market-cap tier. Neither goes to Krypt.',
          'The relayer adds 0.5%, but only when the relayer builds the transaction.',
          'Priority fee: at least 0.001 SOL on a buy and 0.002 SOL on a sell. Above that floor it follows the live estimate at your Fee urgency (sells use one level higher), and it never goes above 0.01 SOL.',
          'Tips: Helius Sender adds 0.000005 SOL. The Jito tip comes from the live tip floor at your percentile (sells always use p95) and is kept between 0.000001 and 0.005 SOL.',
          'A token account costs about 0.002 SOL in rent. A 100% sell closes the account and returns the rent.',
          'If a fee transfer would leave its recipient below rent-exempt, it is left out instead of making your trade fail.',
        ],
      },
      {
        heading: 'Arming, modes and breakers',
        lines: [
          'The trade panel labels its buttons Paper buy / Paper sell whenever the app is not both armed and live-enabled.',
          'Arming needs a wallet. Without one it fails with “Generate and fund a trading wallet first”.',
          'Any disarm (by you, a breaker or a decoder problem) saves Paper as the mode. The one exception is losing the wallet, which keeps Live as the preference.',
          'Re-arm after verified upgrade is on by default. A pump program upgrade disarms the app; if the decoder re-check passes, it re-arms, but only if Live was armed when the upgrade hit.',
          'Session loss cap counts realised losses from confirmed sells since arming. SOL sitting in open positions does not count as a loss.',
          'Breakers pause buys. They never block a sell.',
        ],
      },
      {
        heading: 'What Max SOL / trade limits',
        lines: [
          'It limits advanced orders and copy trading. A script uses its own budget instead. Going over the limit refuses the trade; it is never quietly reduced.',
          'Manual trades are not capped: the trade panel, Discover and Runners quick buy, and hotkeys spend exactly what you entered, minus the exit reserve.',
          'Discover’s quick-buy field starts at 0.1 SOL or your cap, whichever is smaller.',
          'A buy order written above the cap is refused when you create it, and again if it fires.',
        ],
      },
    ],
    careful: [
      'If the saved mode is Live, a newly created or imported wallet arms straight away. The next click spends real SOL.',
      'The key is generated and kept on this computer. Nobody can recover it, including us.',
      'Manual buys ignore Max SOL / trade. Typing 10 instead of 0.10 buys 10 SOL if the wallet holds it.',
      'Private mode can miss a block. If a Private buy cannot keep its Jito tip, it goes out on the public lane and the result message says so.',
      'Not financial advice. Most new coins go to zero.',
    ],
  },
  terminal: {
    what: 'Terminal is where you trade by hand. Discover and Runners find coins, the token page shows what is known about one, and every Buy, Sell, quick buy and hotkey goes through the same signer. Nothing in Terminal opens a position on its own; the only thing that trades without a click at that moment is an advanced order you wrote. Every number the app could not get shows as —.',
    steps: [
      'Discover: pick the stats window (default 5m) and filters. Sort each column (the sort is remembered per column), click a column title to expand it into rows, and pause polling or refresh all columns from the header.',
      'Runners: before opening a flag, compare the bucket rate with the base rate, check the mixed curve and creator sold badges, and look at how much net SOL is behind the move.',
      'Open a coin by clicking it, pasting its address with Ctrl+K, or pressing Ctrl+T for a new tab. With the scanner running, the page shows Taped live, which enables 1s candles, Live trades and Trader scan.',
      'Read the Security tab first (score, mint and freeze authority, Sellable, creator record), then Holders, Launch and Links.',
      'Size the buy in the trade panel (presets 0.05, 0.1, 0.25, 0.5 and 1 SOL). The Est. fees line shows the all-in estimate, the slippage in force and which lane the buy uses.',
      'After the fill, write exits in the Orders panel or let an auto-sell template arm them. Check the order lines on the chart.',
      'Sell with 10, 25, 50, 75 or 100%. Only 100% closes the token account and returns its rent.',
      'When a trade fails, open Wire → Rails to see whether a provider or the app is degraded, and the Console for the exact reason.',
    ],
    details: [
      {
        heading: 'Discover and Runners',
        lines: [
          'New: pump.fun’s latest (asked only while the scanner is starting), Jupiter recent, Raydium LaunchLab and Boop pools under 24 h old from GeckoTerminal, and the app’s own feed. Rails other than pump.fun get up to a quarter of the column.',
          'Graduating: the feed’s own curves (every unfinished pump curve traded in the last 15 minutes, read on-chain), plus pump.fun, Meteora DBC, LaunchLab and Boop. Ranked by exact curve progress; coins whose progress is unknown are left out.',
          'Migrated: pump migrations seen by the feed, pump.fun’s completed list, Raydium pools the app saw created, and new GeckoTerminal pools on non-curve exchanges. Newest first.',
          'Trending: Jupiter’s top traded plus top organic for the selected window, organic first, sorted by volume in that window.',
          'Each column refreshes every 8 s with 40 rows (set in Settings, 5–80), only while Discover is on screen, and fails independently of the others. Numeric filters skip unknown values; launchpad and social requirements exclude them.',
          'Runners: each launch is judged at +60 s and +120 s by a graduation-odds model measured on 73,890 launches, and the top buckets are flagged. Defaults: floor Top 5 %, 12 alerts per hour. Flags expire after 15 minutes.',
          'Runners needs the scanner running and Flag potential runners switched on (Execution page). Rows show the bucket rate, base rate, sample size, % of supply sold, buyers, net SOL, % since flag and the Krypt score.',
          'Runners Buy uses the quick-buy size next to Refresh (default 0.1 SOL, remembered). Sell sells 100% and is only enabled when you hold the coin.',
        ],
      },
      {
        heading: 'Token page',
        lines: [
          'Header Score is the full Security score when at least 4 weighted checks answered; otherwise it falls back to the list score, which needs 3. Passes count in full and warnings count half.',
          'Check weights: Mint authority 14, Freeze authority 16, Token program 6, Liquidity 12 (pass at $25k or more, warn at $5k or more), Sellable (Jupiter Shield) 16, Creator rug history 12, Insider network 10, Launch factory 10, pump.fun ban 10, Creator history 8.',
          'On pump.fun coins, mint and freeze authority are shown as facts, because the program revokes both. Dev, top 10/20, bundled and sniper shares are also shown as facts, with no verdict.',
          'Holders: top 50, as a List or a Map. The Map’s analysis spends RPC calls and shows how many it used.',
          'Links tab: X numbers read from the page when it was opened in the Links panel, Telegram public-preview members, domain registration date, what the website says, and how many other launches on screen link the same X account or post.',
          'Live trades (80 rows) and Trader scan refresh every 3 s and need the coin to be taped.',
          'Graduation odds sit above the trade panel. Pools lists up to 5 pools by liquidity.',
        ],
      },
      {
        heading: 'Chart, tabs, hotkeys, watchlist, Wire',
        lines: [
          'Intervals: 1s, 5s, 15s, 1m, 5m, 15m, 1h, 4h. Opens on 1m in market-cap mode. History comes from Birdeye if you have a key, otherwise GeckoTerminal, merged with the app’s own tape, which wins every candle it saw.',
          'Sub-minute candles need the tape (scanner running, page open) or a Birdeye key. Otherwise the chart shows 1m and says so. Tokens still on a pump curve skip GeckoTerminal.',
          'With nothing cached, the chart draws one seed bar at the current price, marked pending, until history arrives. A USD chart drops SOL-priced ticks while no SOL/USD rate is known.',
          'Token tabs: up to 12; when full, the least recently used tab closes, never the active one. Ctrl+T opens a new tab, Ctrl+Tab and Ctrl+Shift+Tab cycle, Alt+1 to Alt+9 jump, middle-click closes. Ctrl+W is deliberately not used.',
          'Hotkeys: the master switch and every binding start off; confirmation starts on. Defaults: 1/2/3 buy 0.1/0.25/0.5 SOL, Q/W/E sell 25/50/100%, Shift+S emergency sell 100%.',
          'Hotkeys only act on an open Solana token page. They are ignored while typing, on key repeat and while a dialog is open.',
          'Watchlist is stored locally and refreshes every 20 s. With Watch what you buy on (the default), a buy pins the coin and a sell unpins it once you no longer hold any.',
          'Wire has no headlines. It shows Rails (provider and app health, worst first), DexScreener paid boosts and newly filled profiles.',
        ],
      },
      {
        heading: 'How a buy or sell is built',
        lines: [
          'Builders are tried in this order: the local pump curve builder, then the PumpSwap builder (only when the curve reports graduated), then Jupiter, then the PumpPortal relayer. If local building is off, or a sell cannot be sized as a percentage, it goes straight to Jupiter and then the relayer.',
          'The local builder reads the curve, the mint’s token program and pump’s global settings in one batch. v2 curves need the bonding-curve-v2 account, and the relayer rejects open curves with a 400.',
          'Mayhem coins must name pump’s reserved fee recipient. Cashback coins need the user volume account on sells. The local builder handles both.',
          'The local builder refuses curves quoted in anything other than SOL; those go to Jupiter.',
          'A sell is a share of the balance read when the transaction is built, to two decimals (minimum 0.01%).',
          'Every build is checked before signing: you are the fee payer, only your signature is needed, and every top-level program is on the allow-list. It is then simulated. The most it may lose is amount × (1 + slippage) + 0.01 SOL + the exact fee + the exact tips.',
          'A sell expected to pay 0.02 SOL or more is refused if the simulated balance does not rise.',
          'A local or PumpSwap build that fails before broadcast moves on to the next builder. Nothing is rebuilt after a broadcast except the sell retries below.',
        ],
      },
      {
        heading: 'Slippage, lanes and the SOL reserve',
        lines: [
          'Buys use Slippage % (default 12). Sells use at least 15%.',
          'A 100% sell that failed to land retries once, at 2.5 × its slippage (minimum 35%, maximum 50%). A partial sell is never retried.',
          'A sell refused by a rate limit before broadcast is retried once after 1.5 s.',
          'Pending means sent but not yet confirmed or expired. The app keeps watching the signature, so it can still land.',
          'Private sends buys to the Jito lane only. Sells always use every lane.',
          'A transaction is capped at 1,232 bytes. If the extra transfers do not fit, they are dropped in this order: Helius tip, referral cut, Jito tip, and the Krypt fee last.',
          'Buys keep 0.015 SOL back (0.01 exit reserve + 0.005 buy overhead). A buy is trimmed with a warning, or refused if nothing is left. A sell from a wallet with under 0.01 SOL goes without tips and with a smaller priority fee.',
        ],
      },
      {
        heading: 'Advanced orders',
        lines: [
          'Kinds: Limit buy and Limit sell (price in SOL or market cap in USD), Take profit, Stop loss and Trailing stop (percent), Sell if dev sells, Sell on migration, Buy on migration.',
          'Percent orders are measured from a reference price saved when the order is written; with no price, the order is refused. Stop and trailing values must be between 0 and 100%. The limit is 200 orders.',
          'Each order fires once. It is saved as triggered before the transaction is built and is not retried after broadcast. If a rate limit refuses it before broadcast, it re-arms, up to 5 times.',
          'If an order triggers in Paper mode, while disarmed or with no wallet, it stays armed, warns once a minute and fires as soon as trading is possible — which may be at a much worse price.',
          'Orders come back Paused after a restart. Resuming resets trailing peaks. An order written on a different wallet pauses instead of firing.',
          'Only one sell per coin runs at a time. If the balance is confirmed to be zero, the order expires. Market-cap triggers are checked only on the 12 s price poll.',
          'Migration orders fire even for coins the tracker has dropped. Price orders on graduated coins keep checking on PumpSwap trades or the 12 s poll.',
          'Auto-sell templates (Runner, Scalp, Stop only) arm when a manual Live buy lands, unless the coin already has armed orders.',
        ],
      },
    ],
    careful: [
      'Quick buy on Discover and Runners sends immediately with no confirmation, and it is not capped. Hotkeys are not capped either.',
      'In Paper mode your stop losses do not execute. They stay armed and warn once a minute.',
      'A dash means unknown, not zero. No answer from Jupiter Shield does not mean the coin is sellable.',
      'A pending trade may still land. Never resend or rebuy it.',
      'Most new coins go to zero. A runner flag or a high score is not a reason to buy.',
    ],
  },
  layout: {
    what: 'Widgets is a 12-column drag-and-drop grid of self-contained panels. Chart and Links follow the last token opened anywhere in the app, including in popped-out windows; every other panel reads app-wide state. Which panels are on, where they sit, each panel’s chain filter and your menu pins are saved on this computer only. Nothing on this page trades.',
    steps: [
      'Press Panels (top right) and tick the panels you want. The badge shows how many are on out of the total.',
      'Drag a panel by its header and resize it from the bottom-right corner. Panels move up to fill gaps.',
      'On chain-aware panels, set the chain picker in the header to All chains, Solana, Robinhood or BNB.',
      'Hover a header and press the pop-out icon to open the panel in its own window. Esc, or the X that appears on hover, closes it.',
      'Choose the Chart panel’s token from its header list (your watchlist plus the current token), or just open a coin anywhere.',
      'Use Pages to pin any page from any workspace to the left menu while you are on Widgets.',
      'Reset layout (shown once you have moved something) puts every panel back in its default box.',
    ],
    details: [
      {
        heading: 'The 17 panels',
        lines: [
          'Engine, Wallet, Session PnL: scanner state and uptime, balance with live trade counts, and realised PnL for this session.',
          'Open positions, Open orders, Recent fills: what is open, what is still armed, and what actually executed, on every chain.',
          'Live launches, Runner alerts, Observatory: new tokens as the scanner sees them, this session’s runner flags, and whether each chain’s scanner is running and how far behind it is.',
          'Scripts, Script monitor, Copy trading, Alerts: script spend and armed state, one script’s own stats and log, followed wallets, and armed or recently fired alerts.',
          'Chart, Links, Callouts, Games (Snake, Flappy Crypto, Dino, Tetris).',
          'Every panel starts on the first time an install sees it, including panels added in an update. A panel you switch off stays off.',
        ],
      },
      {
        heading: 'How the layout is saved',
        lines: [
          'Saved positions are merged, not replaced, so a panel you switch off keeps its size when you switch it back on.',
          'Minimum sizes come from the current build, even over an older saved layout.',
          'Pages that cannot be pinned: the token pages and Widgets itself.',
          'If local storage is blocked or unreadable, the page starts from the defaults.',
        ],
      },
      {
        heading: 'Pop-out windows',
        lines: [
          'One window per panel; popping out the same panel again focuses the open window. Default size 420×460, minimum 260×200. Size and position are remembered per panel.',
          'Popping out does not remove the panel from the grid.',
          'The whole window can be dragged. The title strip with the chain picker and close button appears only on hover.',
          'A pop-out opens with the chain filter the grid panel had, and receives the same live events as the main window.',
          'Opening a coin from a pop-out brings the main window forward and navigates it; the pop-out keeps showing its panel.',
        ],
      },
      {
        heading: 'Chart and Links panels',
        lines: [
          'Chart: 1m candles, 300 bars, refreshed every 15 s (slower than the token page on purpose). No order lines or markers.',
          'Links: opens on the launchpad page first, then X, website and Telegram. Browser opens the current page in your system browser.',
          'The page runs in a sandboxed view with its own saved session. It cannot see the wallet or keys.',
          'On an X profile it reads followers, following and join date; on a post it reads likes, reposts, replies, views and bookmarks. It reads from the page itself, checking at 1.2, 2.5 and 4 s, and names a login wall when X shows one.',
          'On a Solana token’s website it reads what the site says (two checks). Telegram members and the domain registration date are looked up by the app itself.',
          'Anything it cannot read stays —. Read again reads the page again.',
        ],
      },
    ],
    careful: [
      'Never type a key or seed phrase into a page in the Links panel. It is an external site, not Krypt.',
      'The Chart panel updates every 15 s and has no order lines. Trade from the token page.',
      'Layout, panel choices and pins are saved on this computer only. They do not carry to another machine.',
    ],
  },
  engine: {
    what: 'The Solana scanner hears every pump.fun create and keeps up to 300 launches in memory (held and flagged ones are never evicted). Each one gets hard risk checks and a 15 s evaluation window with gates. It is scored once, then its graduation odds are judged at +60 s and +120 s, and launches in the top buckets are flagged. Robinhood (Pons) and BNB (four.meme) have their own Observatory scanners, built from their own records. Nothing here buys anything: a flag is the odds model’s call plus your own filters, and the gates and score only explain a launch and drive paper research.',
    steps: [
      'Settings › Solana RPC: add a Helius key or extra sockets. The create feed races every socket and drops duplicates. The Standby block feed is on by default and downloads about 5.5 GB/h while scanning, so turn it off on a metered connection.',
      'Press Scanning in the top bar. Observatory shows the Solana launch rate, Launches lists live pump.fun creations with Potential runners at the top, and Console shows decoder and socket warnings.',
      'Execution › Runner alerts: set Flag from bucket (default Top 5 %) and Judge window (default +60 s, then +120 s). Add your own floors: Min buyers at the judge, Min net SOL at the judge, Supply sold at the judge. Each filter only applies when the fact is known.',
      'Choose the skips: Skip mixed curves (leaves few alerts) and Skip creators who dumped before. Set Mayhem coins to All (default), No mayhem or Mayhem only.',
      'Set Max alerts per hour (default 12, range 1–120). To post flags to Discord, paste a webhook on the Runners tab. Each chain has its own webhook, and the saved URL is shown redacted.',
      'Read each flag in full: bucket, observed graduation % with the base rate and sample size, curve regime, % of supply sold, buyers, net SOL at the judge, and “creator sold N s after the flag” if that happens. Open the token and decide yourself.',
      'Strategy is research only. The presets are Strict, Balanced (the defaults) and Loose. Tune Entry gates, Contrarian gates and Exit rules, and turn on Paper entries (research) only if you want simulated positions. Backtest starts from these gates.',
      'To re-fit on your own data, turn on Event recorder in Settings. It is off by default and capped at 2 GB.',
    ],
    details: [
      {
        heading: 'What it hears',
        lines: [
          'Scored and flagged: pump.fun creates only. They come from log subscriptions raced across every socket, plus a standby block feed that takes over if pump’s logs go quiet.',
          'PumpSwap: trades after graduation are decoded for prices and the trade list. The post-graduation standby block feed is off by default because it pulls about 11 GB/h.',
          'LaunchLab (LetsBonk): one program-wide subscription with exact curve progress, but trades arrive without a trader address.',
          'Meteora DBC (Believe and others): only the token you have open is watched, at most 3 pools at once. There is no launch-time bundle analysis and no copy trading on this rail.',
          'Boop: program-wide and fully decoded with real trader addresses, but the rail is nearly dormant. Raydium: new AMM v4 and CPMM pools are seen as they are created, with a trade list (no trader address) for the pool you open.',
          'These rails feed Discover, charts and trade lists. The odds model and runner flags are pump.fun only. Pons (Robinhood; graduates to Uniswap v4 at 4.2 ETH) and four.meme (BNB; graduates to PancakeSwap v2 at 18 BNB) have their own Observatory pages.',
        ],
      },
      {
        heading: 'Evaluation window, gates and score',
        lines: [
          'Evaluation window: 15 s from detection by default (settable 5–60). A hard flag or a creator sell rejects the launch at once. Otherwise it is decided the moment every gate passes, or when the window closes.',
          'Gates (defaults): Min unique buyers 5, Max unique buyers 11, Min net inflow 1 SOL, Max net inflow 18 SOL, Max sells in window 0, Max sell volume 0.4 SOL, Curve entry 4–22 %, Max top-holder share 25 %, Max bundle share 45 % (wallets in the first 2 s), top buyer at most 40 % of buy volume, Min opportunity score 58.',
          'Score (0–100) = safety 20 + creator 18 + sell pressure 18 + entry timing 12 + crowd 8 + concentration 14 + metadata 10, minus penalties. It is computed once, at the decision, and never moves after that.',
          'Safety: 20 − 4 per soft flag when the mint was verified. An unverified mint caps at 8, − 2 per soft flag. Creator: 9 if unknown, otherwise 9 + 9 × completion rate − 13 × dump rate from the app’s record.',
          'Sell pressure: 18 when there were no sells. Any sell caps it at 14 − 9 × sell SOL − 1.5 × sells − 1 × distinct sellers. Entry timing: full marks for curve progress of 10–18 %, falling to 0 at Curve entry min and at Curve entry max + 6.',
          'Crowd: half is a buyers band (full at 5–10 buyers), half an inflow band (full at 3–12 SOL), so big crowds score low. Concentration: penalty when the top holder is above 10 % and when early buyers hold above 20 %. Metadata: 5 for name and symbol, 5 for a metadata link.',
          'Penalties: −25 if the creator sold; −8 if sell volume is over 0.8 × buy volume with more than 2 sells. The score is hand-weighted with no measured hit rate. The gates only drive paper entries, Backtest’s starting values and the “Did not qualify” line on a launch row.',
        ],
      },
      {
        heading: 'Flow numbers, exactly',
        lines: [
          'Unique buyers: distinct wallet addresses that bought since detection. These are raw addresses: linked wallets, bundles and wash trades are not merged. Read it together with early-buyer share.',
          'Buys, sells, volumes and distinct sellers also count from detection. They stop moving at the decision unless the launch stays tracked (you hold it, it is runner-flagged, or it is open or subscribed).',
          'Buyer acceleration: distinct buyers in the second half of the evaluation window divided by the first half, split at the midpoint. A wallet that bought in both halves counts in each. It is 2 when only the second half has buyers, and fixed once the window closes.',
          'Top-holder and early-buyer shares are weighted by tokens held (positive balances only). Top-buyer share is weighted by SOL spent.',
          'Gates and score use SOL-side curve %. The odds judge and flags use token-side “% of supply sold”, which is the real completion condition.',
        ],
      },
      {
        heading: 'Hard flags',
        lines: [
          'Hard rejects: blacklisted creator, missing name or symbol, hidden characters in name or symbol, active freeze authority, unknown token program, malformed mint layout.',
          'Token-2022 hard rejects: non-transferable, transfer hook, permanent delegate, transfer fee, and default account state frozen. Harmless extensions such as metadata pointer and groups pass.',
          'Soft flags (cost safety points): no metadata link, unusual metadata lengths, mint not verified or not readable yet, mint authority still active (normal before graduation).',
          'A hard reject or a creator sell never produces a flag. If the creator sells after a flag, the flag is marked, not removed.',
        ],
      },
      {
        heading: 'Runner flags and odds',
        lines: [
          'Judged at +60 s, and again at +120 s if the first judge did not flag, once there are at least 3 trades. The model was trained on 2026-07-25/26 and its rates are observed on the held-out day 2026-07-27, across 73,890 launches. AUC is 0.87–0.94, but the model is over-confident above ~20 %, so you see observed rates, never the model’s probability.',
          'Buckets on the measured day: Top 1 % ≈ 1 in 4 graduated, Top 5 % ≈ 1 in 6, Top 10 % ≈ 1 in 8.',
          'Never flagged: a hard reject, a creator who already sold, a truncated trade record (the 5,000-trade cap), a curve not quoted in SOL, or too few trades.',
          'Mixed curves (reserves that do not follow the constant product) graduated into pools seeded with about 0.16 SOL, against 85 for a classic curve. An hour later they held a median 0.008× of the flag price. They were 91 % of live September flags.',
          'Flags expire after 15 min, and the engine keeps the newest 50. They go to the Runners tab, desktop notifications, paired chat bots and the Discord webhook. Max alerts per hour caps notifications only; the flags still land on the list.',
          'Mayhem coins trade against inflated virtual reserves (hundreds of SOL instead of 30). The Mayhem coins filter drops them at create, before any check. No mayhem keeps launches the app cannot classify; Mayhem only drops them.',
          'Robinhood and BNB calls come from each chain’s own records: unique buyers in the first 60 s, in buckets. A bucket says nothing until it has 100 settled launches (6 h outcome horizon), and only flags when its Wilson 95 % lower bound is above every other launch’s upper bound.',
        ],
      },
      {
        heading: 'Strategy, Console, recorder',
        lines: [
          'Paper entries (research) is off by default. Exit defaults: Stop loss 35 %; Take profit 1 at 60 % (sells 50 %); Take profit 2 at 150 % (sells 50 % of the rest, then trails); Trailing stop 25 %; Time stop 90 s; Session loss limit 0.5 SOL; 4 losses in a row pauses entries for 5 min; 0.1 SOL per position, 3 open at most.',
          'Console keeps the last 500 lines, filters by severity and searches. It only follows new lines while you are scrolled to the bottom.',
          'Event recorder: off by default. Launch mode writes about 1.2 GB/day; Firehose about 15 GB/day. It is capped at 2 GB and deletes the oldest day first, which holds about 1 day of launch data or about 3 hours of firehose.',
        ],
      },
    ],
    careful: [
      'A flag is not a buy signal. On the held-out day 18 in 100 flags graduated (11 in 100 live on 09-10/11), yet 69 % were at half the flag price five minutes later. Buying every flag with 0.1 SOL lost 1.24 SOL per 100 flags under a 25 % trailing stop, and other exits did worse.',
      'Runner forward returns are not an edge. A model trained on forward returns did not beat the graduation model (none of 46 variants cleared the bar), and classic-curve flags were no better than break-even (n = 186).',
      'Paper entries lost money in the measured record even with perfect landing, and paper fills do not predict live results.',
      'Unique buyers counts raw addresses: one person with twenty wallets is twenty buyers.',
      'The Standby block feed is on by default and downloads about 5.5 GB/h while scanning. Firehose recording writes about 15 GB/day.',
    ],
  },
  scout: {
    what: 'Wallet Scout keeps a separate record per chain (Solana, Robinhood, BNB — never merged) of what wallets did, in daily buckets kept for 45 days. Every closed trip is valued twice: what the wallet made, and what someone copying it would have made. The Copy score ranks the least-bad wallets to follow. Research on 9.3 million curve trades found no group of wallets that was profitable to copy.',
    steps: [
      'Pick the chain and press Record live. On Solana this starts the scanner; on Robinhood or BNB it starts that chain’s Observatory. Records grow from every trade the app hears.',
      'To fill the board now, use Scan the past: 1h, 6h (default) or 24h. On Solana it reads the pump.fun tokens Discover is showing — up to 60 tokens, 300 trades each, one request every 2 s — and usually takes about two minutes. On EVM chains it reads curve trades from the RPC in block chunks. Scanning spends nothing.',
      'Pick a window (Today, 7 days, 30 days, All time) and sort by Copy score or Follower return. Their profit, Their return, Their win rate, Round trips and Volume are the wallet’s own numbers.',
      'Press Only the ones worth a look to turn on all five filters: No bots, Enough trades, You could have copied, Holds over a minute, Trades most days. You can also toggle them one by one. A row whose value was never measured is not hidden.',
      'Click a row to see the five checks, the flags, Median hold and Under a minute, and recent trips, each with a follower return or the reason there is none.',
      'For an address the feed never saw, paste it into Look up a wallet and press Read from the chain (Solana). That reads its last 200 transactions from the past week. The copy numbers still need the live feed or a scan.',
      'Save the wallets you want to keep; saved wallets are never dropped. Follow on paper or Reverse on paper adds a Solana copy config that stays on paper and switched off until you arm it.',
    ],
    details: [
      {
        heading: 'Record and limits',
        lines: [
          'At most 6,000 tracked wallets per chain. Past that, thin records (under 5 closed trips) are dropped first, least recently active first, then ranked records the same way. The count line says so when you reach the cap.',
          'A wallet needs 5 closed round trips in the window to be ranked. Below that it is marked thin and listed after ranked wallets.',
          'Order: ranked wallets first, then humans before bots, then the chosen sort (unknown values last), then more round trips.',
          'Profit is realised only: sells matched against buys the app saw. A sell with no buy behind it is counted but never valued, and open positions are not valued.',
          'pump.fun blocks an IP for about 35 s after roughly 22 fast requests, so the Solana scan sends one request every 2 s. Other Solana rails have no history to scan.',
          'You can clear every tracked wallet on a chain to start over; saved wallets are kept.',
        ],
      },
      {
        heading: 'How the Copy score is built',
        lines: [
          'Copier entry: the first trade on that coin at or after the wallet’s buy + 2 s. Copier exit: the same, 2 s after the wallet sells. Costs are 1.5 % a side (the venue’s 1 % plus Krypt’s 0.5 %).',
          'Slippage and partial exits are not modelled (partial exits are scored on the final close), so the numbers are generous.',
          'Trips a copier could not take: too fast (the wallet was out before the copier’s turn), no entry (no trade to enter on before the wallet sold), no exit (no trade to exit on within 10 min). They are counted, never valued.',
          'Checks and weights: Follower return ×3, Follower win rate ×2, Reachable trips ×2, Active days ×1 (only for windows of 3+ days), Coins per trip ×1. The score is the weighted average of the checks that could be measured.',
          'No score (a dash) under 5 closed trips or when fewer than 3 checks could be measured. The two copier checks each need 5 trips a copier could have taken.',
          'Follower return points: −25 % → 0, −10 % → 35, −3 % → 60, 0 → 75, +10 % → 100. Win rate points: 20 % → 0, 45 % → 60, 60 % → 100. Across all recorded trades, even the best wallets sit near −3 % median and about 45 % wins.',
          'Colour: 70 and up green, 40–69 amber, below 40 red.',
        ],
      },
      {
        heading: 'Flags and fast flippers',
        lines: [
          'bot: median hold under 10 s with at least 10 round trips. Listed after humans; hidden by No bots.',
          'thin: under 5 closed trips. unreachable: a copier could have taken under 25 % of the trips checked. concentrated: 4 or more trips per coin. partial: the copy numbers cover less than half of the window’s trips.',
          'Under a minute: the share of trips opened and closed within 60 s, shown red at 50 % or more. Holds over a minute hides wallets whose median hold is under 60 s, the same minimum copy trading uses.',
          'The typical top wallet holds about six seconds. Its edge is speed, which a copier cannot copy: the app takes about 1.4 s to land a trade, plus feed delay.',
        ],
      },
    ],
    careful: [
      'The Copy score finds the least bad, not a winner. No group of wallets was profitable to follow; the best lost about 1–3 % per copied trade after costs.',
      'Ranking by past profit picks up luck as readily as skill. A good rank this week is no proof of next week.',
      'The score leaves out slippage, so real copies do worse than it shows.',
      'Follow and Reverse start on paper and switched off. Reverse copying is an unmeasured bet.',
    ],
  },
  launch: {
    what: 'Creates a token on Solana (pump.fun create_v2) or Robinhood Chain (Pons launchAndBuy), signed by a separate launch wallet, and you must buy some of it yourself at launch. It is off by default, and while off the app refuses any transaction that needs a second signature. When on, it accepts exactly one extra signer: the new mint key the app generates, which exists for about two seconds and is never written to disk.',
    steps: [
      'Read Read this before you turn it on, then turn on Allow launching from this install.',
      'Under Where, pick Solana (pump.fun) or Robinhood Chain (Pons). Choose a Launch wallet for that chain — it cannot be your active trading wallet — and fund it for the create and your first buy.',
      'Solana only: live execution must be on and armed, because your first buy goes through the normal trade path. The page blocks the launch until it is.',
      'Fill in Name (up to 32 characters), Ticker (up to 10, letters and digits only) and Description (463 characters for your own words), plus optional Twitter, Telegram and Website. Pick an image (PNG, JPG, GIF or WebP) and press Pin to IPFS.',
      'Set Your own first buy (at least 0.01 SOL or 0.002 ETH). On Solana, tick Mayhem mode or Cashback only if you mean it. On Robinhood, set Creator fee (basis points), 0–500, default 100.',
      'Press Check it first, which simulates the launch against the live chain, then press Launch.',
      'For an automatic public call, set up Automation › Auto-callout: write callout text and keep Call out coins I launch on.',
      'Afterwards, My launches lists every attempt with the token and transaction hash, and Creator fees › Claim collects what your coins have paid you.',
    ],
    details: [
      {
        heading: 'The create, per chain',
        lines: [
          'Solana uses create_v2 with a Token-2022 mint. All 16 accounts come from pump’s on-chain program description, were checked against three real launches, and are pinned by tests.',
          'Solana takes two transactions: the create, then your buy through the normal trade path (checked, charged the usual fee, and recorded as a position). For a few seconds in between, someone else can buy first.',
          'Solana create budget: 250k compute units at 200k micro-lamports (about 0.00005 SOL). A create that would cost you more than 0.02 SOL is refused.',
          'Robinhood uses Pons launchAndBuy: create and buy in one call, so nobody can buy in front of you. The router adds a flat 0.0005 launch fee on top of your buy.',
          'Every launch is simulated before signing, and nothing is sent until the simulation passes.',
          'If the token is created but your buy fails, the launch still counts as a success with a note, so do not launch a second one. A create that timed out may still have landed: look up its hash in My launches before trying again.',
        ],
      },
      {
        heading: 'First buy and fees',
        lines: [
          'The first buy is required so every launch pays the normal 0.5 % fee like any other trade; a free signing path could be abused. On Robinhood the 0.5 % is charged separately once the launch confirms.',
          'Cashback sends your entire creator fee to traders, permanently. 44 % of pump launches use it, which is why the typical successful launch pays its creator nothing.',
          'Mayhem mode trades against inflated virtual reserves, and its fee goes to a reserved recipient.',
          'Creator fees (Solana): one vault per launch wallet collects fees from every coin it launched, so one Claim takes everything. The amount shown is what is above the vault’s rent. If the vault cannot be read you see a dash, not 0.',
          'Claim is a normal one-signature transaction. Fees paid in a token other than SOL are not collected here.',
          'Robinhood creator fee: a share of every trade, in basis points, paid to the launch wallet. 100 basis points is 1 %.',
        ],
      },
      {
        heading: 'Watermark and metadata',
        lines: [
          'Every launched coin’s description ends with a Krypto Bot line on its own line. It is written into the metadata the token points to, so it travels with the coin.',
          'The line rotates on every write between six versions (e.g. “Launched with krypt.cc/bot”, “made with Krypto Bot”). Every version names Krypto Bot or its URL.',
          'Any existing line, including the old one, is removed before a new one is added, so editing never leaves two.',
          'The description counter counts down from 463, not 500, to leave room for the longest line.',
          'The image and details are pinned to IPFS through pump.fun’s public uploader on both chains. Pinning publishes them but does not create a token.',
        ],
      },
      {
        heading: 'Auto-callout on launch',
        lines: [
          'Call out coins I launch (Automation › Auto-callout) is on by default but posts nothing until you have written callout text. It is a separate switch from Call out what I buy.',
          'Solana only. It posts from the launch wallet’s pump.fun account, and only if your first buy went through.',
          'It only posts if the first buy is worth more than $2 (the default; 0 means any size, though pump still needs the coin to be worth $1). If the SOL price is unknown, nothing is posted.',
          'It posts 30 s after the launch so pump does not drop it. It uses the same text, Like your own callouts setting and Discord webhook as other auto-callouts. A failed callout never counts as a failed launch.',
        ],
      },
    ],
    careful: [
      'Out of 73,890 launches, 82.5 % were dead within ten minutes, about 2 % graduated, and roughly 1 in 5,000 kept paying fees. A launch with no audience is worth one to three dollars.',
      'A token cannot be deleted, and it stays tied to your launch wallet’s address. The app’s own creator check calls ten launches in a day a launch factory, and it will flag yours.',
      'Cashback cannot be undone. A callout is public and posted under your name.',
      'You are responsible for what you create and share, and for the rules where you live.',
    ],
  },
  wallets: {
    what: 'Wallet Utilities holds your Solana wallets (Sol Wallet), the EVM wallets for Robinhood Chain and BNB, and the tools that move money: Swap, Bridge, Wallet list and Funder. The app holds up to 15 Solana wallets, each key encrypted by the operating system’s keystore, but only one of them, the active (main) wallet, signs trades. Each wallet has its own pump.fun account, balance cap and withdrawal address.',
    steps: [
      'Make wallets with New wallet on Sol Wallet, or several at once in Wallet Lab → Wallet list (Make N wallets, optional label prefix). The first wallet ever made becomes the main wallet. Adding more never changes which wallet signs.',
      'Import a key with Import key or Import. It accepts base58 or a JSON byte array, as a 64-byte keypair or a 32-byte seed. A key already in the list is refused.',
      'To change which wallet signs, switch the top bar to Paper first. Picking another wallet and Make main are refused while live execution is armed. Removing a wallet disarms first and also signs its pump.fun account out.',
      'Set Safety rails for each wallet. Max balance cap defaults to 2 SOL (0–100) and only warns. Withdrawal address changes must be confirmed in a system dialog.',
      'Back up from Backup & removal. Back up keypair writes a Solana CLI JSON file. Export all (Phantom) writes every private key to a plain-text file.',
      'Send SOL to your other wallets with Funder → Fund wallets (12 transfers per transaction), and bring it back with Collect back (one transaction per wallet). Both need live armed.',
      'Sign each wallet in to pump.fun from Sol Wallet → pump.fun accounts or Automation → pump.fun accounts. Each wallet has one account, and all of them can be signed in at once.',
      'On Robinhood Wallet or BNB Wallet, press Check my rewards to see what Merkl reports that wallet has earned on that chain. Nothing is sent until you press it.',
      'Use Swap for token-to-token on one chain. Use Bridge to move a chain’s own coin to another chain. Bridge is off by default; turn it On at the top of its page.',
    ],
    details: [
      {
        heading: 'Keys and the signer',
        lines: [
          'Keys are encrypted with the operating system’s keystore (Windows DPAPI, macOS Keychain) into wallets.json in the app’s data folder. They are decrypted only inside the app’s main process, only to sign.',
          'If the system keystore is unavailable, Generate and Import are refused. The app will not store a key unencrypted.',
          'If wallets.json cannot be read, the app never writes over it. The store goes read-only and says why, so the keys in the file can still be recovered.',
          'Only the active wallet signs. Every signature checks where the SOL goes before the key is decrypted: SOL can leave only as a trade or to the stored withdrawal address.',
          'Live is the default mode. Once a wallet exists, the app arms itself at start-up. Any disarm, yours or a safety breaker’s, saves Paper as the mode.',
          'The 15-wallet limit is checked only when you add a wallet. A file that already holds more keeps every key but cannot grow until it is under 15.',
        ],
      },
      {
        heading: 'EVM wallets (Robinhood Chain and BNB)',
        lines: [
          'Both chains share one key list, up to 20 EVM wallets. A key has the same address on both chains, but each chain picks its own signer and is armed separately in the top bar.',
          'Each wallet records the chain whose page made it (its home chain). A chain only takes its own wallets, or wallets made before 2026-09-12, which belong to both. A BNB wallet is never Robinhood’s fallback.',
          'A wallet made on a chain’s page becomes that chain’s signer at once if the chain has no signer or shares one with the other chain. That switch is refused while the chain is Live.',
          'Assign moves a wallet made before 2026-09-12 to one chain. It is refused while that wallet signs on the other chain.',
        ],
      },
      {
        heading: 'Swap',
        lines: [
          'On Solana, Jupiter routes any token to any token in one transaction. Robinhood Chain and BNB only swap to or from their own coin: one side must be ETH or BNB.',
          'Slippage is 0.1–50%, default 1%. Speed sets the priority fee against current bids: Cheapest is p50, Normal is p75 (default), Fast is p90. A faster speed lands sooner; it does not improve the price.',
          'A swap opens no position and records no PnL. It pays Krypt’s fee, halved for $KRYPTO holders. If the input cannot be priced in SOL, no fee is charged. On EVM the fee is taken inside the trade.',
        ],
      },
      {
        heading: 'Bridge (LI.FI)',
        lines: [
          'Chain coins only, so no token approvals are ever granted. Routes: Solana→Robinhood, Robinhood→Solana, Robinhood→BNB, BNB→Solana, BNB→Robinhood. Solana→BNB is off in this build.',
          'Krypt takes no fee on a bridge. LI.FI takes 0.25% and the bridge adds its own cost (about 0.9% when measured), both taken out of what arrives.',
          'Transfers under $5 are refused, because a failed transfer that small is not refunded. Transfers under $25–$100, depending on the route, get a warning.',
          'From an EVM chain, the recipient, destination chain and minimum output are checked in the transaction before signing. A transaction from Solana does not contain them, so that side is trusted, not checked.',
          'A transfer is saved as soon as it is sent and survives a restart. Could not check means the status is unknown, not that the money is lost. A refund comes back on the chain it left, usually as a stablecoin.',
        ],
      },
      {
        heading: 'Wallet Lab, pump.fun accounts, Merkl',
        lines: [
          'Funder: each wallet it pays must end up rent-exempt (about 0.0009 SOL), or that batch fails. A batch counts only once it is confirmed. At most 20 wallets per action, and the app only pays wallets it holds.',
          'Collect back sends everything above rent and fee headroom. Tokens are not moved, so sell them first.',
          'pump.fun sessions are held per wallet, last about 14 days, and are encrypted at rest. The session token never leaves the app’s main process.',
          'After sign-in, the app registers the account with pump, which likes, follows and callouts need. It then applies the kryptcc referral and puts Using krypt.cc/bot in the bio.',
          'Check my rewards shows what Merkl reports this wallet has earned on that chain. The app never shows a claim link or any third-party URL. If Merkl cannot be read, it shows a dash, not zero.',
        ],
      },
    ],
    careful: [
      'Nobody can recover a lost key. Export all writes every private key in plain text: keep that file offline and delete it once the keys are imported somewhere else.',
      'Importing a wallet you use elsewhere puts it under this app’s signer. Prefer a fresh wallet, and fund it only with what you can afford to lose.',
      'Auto-sell on stop or crash (off by default) sells every token in the wallet at up to 15% slippage, including tokens the app never bought.',
      'If a withdrawal-address confirmation appears when you did not ask for one, press Cancel.',
      'A bridge from Solana cannot be checked on the far side before signing, and a small failed transfer may never be refunded. Check the chains and the amount twice.',
    ],
  },
  system: {
    what: 'Settings & Legal holds Settings, About and Legal: RPC endpoints, market data providers, display, fees and referral, logs, recording, and the documents you accepted. The defaults work; a Helius key or your own execution endpoint is what makes trades faster. The app has no telemetry: nothing on these pages is sent anywhere unless you send it.',
    steps: [
      'Settings → Solana RPC: paste a Helius API key (just the key, or a full URL containing api-key=), then press Save RPC settings.',
      'Optional: fill in Execution endpoint (https only, any provider). When it is set, it is used for trades instead of the Helius key.',
      'Press Measure under Endpoint speed. It sends five requests to each saved endpoint and shows median and best time in ms, how many slots it is behind the freshest one, and whether it refuses holder reads.',
      'Market data: switch off providers you do not need, and check each one’s calls, errors, latency and whether it is paused.',
      'Display: choose Language, Accent and Look. On a slow or unstable machine, turn on Lite mode (reduce effects) or turn off Hardware acceleration.',
      'Fees & referral: check the rate you are paying now, paste your referrer’s SOL address, or copy your own address from Refer someone else.',
      'If something breaks, open Logs, describe what happened, press Save logs to a file (or Copy to clipboard), and attach it in Discord.',
      'Before any trade, check Paper / Live in the top bar. Each chain is armed separately.',
    ],
    details: [
      {
        heading: 'RPC lanes',
        lines: [
          'HTTP (account lookups) and WebSocket (launch feed) use free public endpoints by default. Extra WebSocket endpoints all run at once and the first to deliver an event wins.',
          'The Helius key is used for trade simulation, sending, confirmation, send-time fee estimates, and holder and token-account reads. Launch scanning and plain reads stay on public endpoints. The free Helius plan allows about 10 requests a second, and the app stays under that.',
          'Execution endpoint carries live buys, sells, confirmations and send-time fee estimates. Mint checks, balances and holder reads stay on the HTTP endpoint, so you do not pay for bulk traffic.',
          'Helius feed socket is off by default. In a test it delivered 92% of events first, but it uses about 800k credits a day. When the monthly credit limit (default 1,000,000) is used up, the app turns the socket off.',
          'Standby block feed is on by default and downloads about 5.5 GB/h while scanning. The post-graduation version is off by default and downloads about 11 GB/h. Turn both off on a metered connection.',
          'RPC changes made while the scanner is running apply on the next start. Commitment is processed or confirmed.',
        ],
      },
      {
        heading: 'Public RPC limits and rate limiting',
        lines: [
          'The public endpoint limits each method per 10 seconds: for example getBalance 150, getAccountInfo 50, getTokenAccountsByOwner 10, and getTokenLargestAccounts 0 (closed). The app updates these limits from the endpoint’s own rate-limit headers.',
          'Requests to one host start at 10 per second and never go above 50.',
          'A 429 pauses that host, or only that method, for its Retry-After time, otherwise 1 s doubling up to 10 s. Reads switch to another endpoint. A trade waits at most 2.5 s and is never dropped. Sending a transaction is never delayed.',
          'Market data providers pause the same way. “rate limited · retrying in X” clears by itself. “no allowance left · paused X” means the plan’s quota is used up and waiting will not fix it.',
          'With Allow market data providers off, Discover and charts are empty, but on-chain reads, the live feed and the scanner keep working. Each provider sees your IP and the tokens you look up. Load token images shows your IP to the image host.',
          'A Jupiter API key moves all Jupiter calls, buy and sell quotes included, from lite-api.jup.ag to api.jup.ag, limited to 1 request a second. Birdeye needs a key.',
        ],
      },
      {
        heading: 'Display',
        lines: [
          'Language: 8 languages (English, Spanish, Korean, Brazilian Portuguese, Russian, Turkish, Vietnamese, Simplified Chinese). Legal documents and anything describing your money stay in English.',
          'Accent: Purple (default), Blue, Red, Green, Grey. Look: Classic (default), Futuristic, Minimal, Hacker, Retro, XP / Y2K (the only light look). Neither changes the colours for up, down and money.',
          'Lite mode (reduce effects) turns off animations, blur, glows and the star background, and replaces the 3D scenes with still images. The Hub’s Laggy? button is the same switch.',
          'Hardware acceleration turns itself off after the graphics process crashes twice in one run. Changes apply on restart.',
        ],
      },
      {
        heading: 'Logs, recorder, crashes',
        lines: [
          'app.log holds up to 5 MB, with one older file, app.log.1. Every line has secrets removed before it is kept in memory or written to disk.',
          'The support bundle contains app versions, your settings with every secret removed, what is switched on, provider status, a list of files by name and size, crash file names, and the log. It is capped at 6 MB; if longer, the oldest part is cut.',
          'Any setting whose name ends in key (except publicKey and pubkey) is removed, and so is any token. Never included: private key, seed, API keys, balances, holdings, trade history.',
          'Event recorder is off by default. Launch tape writes about 1.2 GB/day and Firehose about 15 GB/day. Recordings are capped at 2 GB by default, oldest day deleted first. The Helius key is removed from recordings.',
          'When the app hits an unexpected error it keeps running: the error is logged, shown once per run as a notification, and saved to a crash file kept for 7 days. It quits only if no window is open yet, or if more than 25 errors happen within 10 seconds.',
        ],
      },
      {
        heading: 'Legal and going live',
        lines: [
          'The documents are the Terms, the Privacy Policy and the Software terms. Each acceptance is saved on this computer with a SHA-256 hash of each document’s full text. No IP address is recorded. Records are kept about 7 years, then deleted.',
          'A new terms version asks you to accept again. Declining closes the app. Minimum age is 18.',
          'Paper / Live is set in the top bar, per chain, and Go Live asks for confirmation. Whenever something disarms live trading, the saved mode goes back to Paper.',
          'Session loss cap and Losses in a row (Sol Wallet → Live execution) are both off (0) by default and apply to Solana only.',
          'The Kill switch disarms Solana and every armed EVM chain, and stops the EVM scanners.',
        ],
      },
    ],
    careful: [
      'Live is the default mode. If a wallet exists, the app arms itself at start-up, so check the top bar before pressing Buy.',
      'A Helius key or execution endpoint URL is a password. The app removes it from logs and the support bundle, but never paste it into a chat or a screenshot.',
      'Read the support file before you send it. It names the coins you looked at and the trades you made.',
      'Firehose recording writes about 15 GB a day. Point Store directory at a drive with room, or leave it off.',
    ],
  },
  callouts: {
    what: 'A callout is a public pump.fun post from one account saying it holds a coin, and pump shows the account’s position beside it. pump allows one callout per coin per account, and it cannot be edited: to add to it you post a reply, which also bumps the callout back up. The app posts callouts from Auto-callout (your manual buys and your launches), from Post one now, and from scripts. Every post first passes pump’s eligibility check and gets a Krypto Bot credit line added.',
    steps: [
      'Sign in the wallet that will post (Automation → pump.fun accounts). Auto-callout on a buy posts from the active trading wallet’s account.',
      'Automation → Auto-callout → What to say: write up to 30 lines, one per variant, 174 characters each. You can use {ticker}, {name}, {mc}, {price}, {holders}, {buyers}, {liq} and {mint}.',
      'Press Save, then try Post one now: pick Post as, a Token that wallet holds, and the words. Choose New callout or Reply to my callout first.',
      'Turn on Call out what I buy and set Skip buys under (SOL). 0 means every buy is called out.',
      'Call out coins I launch is on by default. Set Only if the dev buy is worth over (USD, default 2).',
      'Keep Like your own callouts on (the default) or turn it off.',
      'Optional: under Post your callouts to Discord, paste a webhook, save it and send a test.',
      'To post from several accounts or on your own schedule, use a script: bot.callout(mint, text?, address?), bot.calloutReply(mint, text, address?), bot.pumpAccounts().',
    ],
    details: [
      {
        heading: 'What pump enforces',
        lines: [
          'Before every post the app asks pump’s eligibility check and follows its answer. The account must hold at least $1 of the coin, and pump’s remaining-attempts count is respected at zero.',
          'One callout per coin per account. If that account already called the coin, the app refuses with “you have already called this coin — reply to it instead”.',
          'A reply adds to the callout and bumps it back up. The account must have called the coin already, pump’s reply cooldown applies, and pump allows 10 replies per 60 s.',
          'Callouts are Solana only, and no way to edit one is known.',
        ],
      },
      {
        heading: 'When Auto-callout posts',
        lines: [
          'Only after a live buy you placed by hand has confirmed. Scripts, copy trades and advanced orders never trigger it, so it cannot use up pump’s one callout before a script’s own post.',
          'Paper buys, failed buys and buys below Skip buys under do not post. Buying more of a coin you already called does not post a reply.',
          'For a launch, it posts from the launch wallet’s account 30 seconds after the dev buy, only if the dev buy is worth more than the USD minimum. If the SOL price is unknown, nothing is posted. It needs callout text written.',
          'A refusal is logged to the Console. It is not retried and does not pop up a message. A failed callout never marks the trade as failed.',
        ],
      },
      {
        heading: 'Text and the credit line',
        lines: [
          'Each callout uses one of your lines at random. A value the app does not know shows as —, never 0. A variable name it does not recognise is left as typed, and <ticker> works as well as {ticker}.',
          'Every callout and reply ends, on its own line, with a Krypto Bot credit picked at random from 10 wordings (for example “Called with krypt.cc/bot” or “via Krypto Bot”). Every wording names the tool.',
          'Your line is cut to length before the credit is added, so the credit is never cut off. The maximum is 200 characters for a callout and 500 for a reply.',
        ],
      },
      {
        heading: 'Discord and scripts',
        lines: [
          'The webhook must be https, on a Discord host (discord.com, discordapp.com, canary.discord.com, ptb.discord.com), in the form /api/webhooks/<id>/<token>, and at most 400 characters. It works like a password and is never logged in full.',
          'Each Discord post shows the coin, your words, a link to the callout, market cap, holders, buyers and curve progress. No wallet or position data is sent.',
          'In a script, leaving out the text uses a random Auto-callout line. address picks which of your signed-in accounts posts; an address with no session is refused rather than swapped for another account. Leaving it out posts from the active wallet.',
          'A paper script posts nothing and logs what it would have said. Each post counts against the script’s actions-per-minute limit. A script will not call the same coin from the same account twice in one run.',
        ],
      },
    ],
    careful: [
      'Callouts are public, carry your account’s name, and cannot be edited or deleted from the app.',
      'Many of your own accounts calling the same coin looks like fake consensus. pump has already restricted an account for identical repeated posts.',
      'Paper buys never post, but Post one now and a Live script post real callouts.',
      'Payouts follow the trading volume your calls bring in. Calling every small trade uses up the reputation that earns them.',
    ],
  },
  'callout-rewards': {
    what: 'pump.fun pays callout rewards in USDC to the wallet of the account that made the call. The app shows what pump says it has paid and can move that USDC, but it never pays or claims anything itself; pump decides the rewards. Accounts made or signed in here are referred by Krypt (code kryptcc), and pump pays Krypt a share of each account’s callout rewards, taken from that account’s share.',
    steps: [
      'Open Automation → pump.fun accounts → Callout rewards and press Refresh. Accounts are checked one at a time.',
      'For any account marked Not accepted — accept terms, read pump’s callout-reward terms (linked on the panel), then confirm. This records acceptance with pump for that one account.',
      'Check Paid (confirmed USDC), referrals, and the latest payout and its status.',
      'Under USDC in your wallets, pick Swap to SOL or Send to <withdrawal address> for each wallet.',
      'Swap to SOL needs Live armed. It swaps all of that wallet’s USDC through Jupiter at 1% slippage, normal speed, with the usual 0.5% fee. The SOL stays in that wallet; use Collect back on Funder to move it.',
      'Before sending, set and confirm a withdrawal address for that wallet on Sol Wallet. Send moves all of the wallet’s USDC there.',
    ],
    details: [
      {
        heading: 'What is read',
        lines: [
          'Using the account’s own session, the app reads pump’s reward-terms status, the last 10 reward payouts and the referral totals.',
          'Paid is pump’s total of confirmed payouts only, across all of the account’s wallets.',
          'Payout states are shown as awaiting approval, on its way (pending, signed or submitted), paid (confirmed), failed, rejected or unknown.',
          'terms: unknown and a — mean pump did not answer. They never mean not accepted or $0. A 401 from pump means the session has expired and you need to sign in again.',
        ],
      },
      {
        heading: 'Sending USDC',
        lines: [
          'The only destination is the wallet’s stored withdrawal address, and the signer reads it itself; nothing else can supply an address. The signer allows USDC only for this.',
          'The transaction may contain only one USDC transfer to that address’s token account, plus creating that token account if it does not exist yet (about 0.002 SOL rent).',
          'The signed transaction is simulated first. Nothing is sent unless the full amount arrives and no more than rent plus fees in SOL leaves the wallet.',
          'Changing the withdrawal address needs confirmation in a system dialog.',
        ],
      },
      {
        heading: 'Referral terms',
        lines: [
          'The kryptcc referral is applied right after sign-in. pump only accepts a referral within 24 hours of an account’s first sign-in, and never for an account older than its referral programme. Such accounts are left as they are.',
          'pump takes Krypt’s referral share out of the account’s reward in each daily payout round. pump sets the amounts. The referral cannot be switched off.',
          'A pump session lasts about 14 days. After it lapses, rewards cannot be read until you renew it on the Sessions list.',
        ],
      },
    ],
    careful: [
      'An account that has not accepted pump’s reward terms may never be paid.',
      'USDC can only go to the withdrawal address confirmed for that wallet. If a confirmation appears that you did not ask for, press Cancel.',
      'The app never claims rewards and never shows a claim link. Anyone offering to claim them for you is running a scam.',
      'Swap to SOL moves real money and pays Krypt’s fee.',
    ],
  },
  fees: {
    what: 'Krypt charges 0.5% of a trade’s SOL value on each side, the buy and the sell. The fee is added to the same transaction before it is signed. Holding 1,000,000 $KRYPTO across the app’s wallets halves it to 0.25%. pump.fun’s fee, the relayer fee, network fees, priority fees and tips are separate, and none of them go to Krypt.',
    steps: [
      'Settings → Fees & referral shows the rate you pay right now. The trade panel shows it again before you confirm.',
      'For the holder rate, keep 1,000,000 $KRYPTO in any wallet in the app. The Scan button on the Hub card re-checks it.',
      'Paste your referrer’s SOL address once. They then get 20% of Krypt’s fee on each of your trades.',
      'To refer other people, copy your address from Refer someone else. On EVM chains your EVM address is used instead.',
      'Set landing costs on the Execution page under Landing configuration: Fee urgency, Jito tip percentile, Sandwich exposure, Jito bundles, Helius Sender (free) and Local transaction builder.',
    ],
    details: [
      {
        heading: 'Krypt’s fee',
        lines: [
          '0.5% per side, so 1% for a buy and a sell, charged on the trade’s SOL value. A fee under 1,000 lamports is skipped, so trades under about 0.0002 SOL pay nothing.',
          'The fee and the tips are added before the transaction is checked and signed, so what is simulated and loss-checked is exactly what is sent.',
          'If the transaction hits its 1,232-byte size limit, transfers are dropped in this order: Helius tip, referral share, Jito tip, and Krypt’s fee last. A fee that cannot be added never blocks the trade.',
          'A buy is refused if Krypt’s fee was removed from it. A sell never is, so you can always exit.',
          'The EVM chains charge the same 0.5%. Bridges carry no Krypt fee.',
        ],
      },
      {
        heading: 'The $KRYPTO holder rate',
        lines: [
          'The threshold is a number of tokens, 1,000,000 out of a supply of 1,000,000,000, not a dollar amount. The dollar value is only shown for information.',
          'It counts every Solana wallet the app holds keys for, checked every 2 minutes. A reading older than 10 minutes is not used.',
          'If the balance cannot be read, the fee is not halved.',
          'It halves the fee on trades, swaps, and EVM buys and sells. It does not change pump’s fee or any network costs.',
        ],
      },
      {
        heading: 'Referral',
        lines: [
          '20% of Krypt’s fee goes to the named address in the same transaction and comes out of Krypt’s share. That is 0.1% of the trade, or 0.05% when the trader holds $KRYPTO.',
          'The referral share is skipped, with a note in the trade result, if the address is invalid, is Krypt’s fee address, or is the trading wallet; if paying it would leave the address below the rent-exempt minimum; or if the transaction is at its size limit.',
          'Naming another wallet you own as your referrer is not detected.',
          'pump.fun: every account made or signed in here is referred by Krypt (code kryptcc). pump pays Krypt a first-deposit reward, which costs you nothing, and a share of the account’s callout rewards, taken from the account’s share.',
        ],
      },
      {
        heading: 'Other costs',
        lines: [
          'pump.fun charges about 1% per side on its bonding curve. The relayer, used only as a last fallback, adds 0.5% per side. The Local transaction builder (on by default) avoids the relayer fee.',
          'Fee urgency defaults to competitive (a percentile of current priority bids). Jito bundles are on, with the tip at p75 of the live tip floor, and Helius Sender (free) is on. These fees go to validators.',
          'Sandwich exposure is Fast by default, which sends on the public RPC plus the staked and bundle lanes. Private sends buys only through the Jito bundle lane: it costs a tip and can miss a block. Sells always use every lane.',
          'Launching: pump’s token creation costs about 0.0067 SOL (0.0101 in mayhem mode). The dev buy goes through the normal trade path and is charged like any other buy.',
          'Sending USDC to an address that has no USDC token account costs about 0.002 SOL rent.',
        ],
      },
    ],
    careful: [
      'Do not use your own trading wallet as the referrer. It is refused and nobody gets the share.',
      'If your $KRYPTO drops below 1,000,000, you pay the full fee again from the next check.',
      '$KRYPTO is a memecoin issued by Krypt, and Krypt earns pump.fun creator fees on it. It can go to zero. This is not financial advice.',
      'Private mode can miss a block. Sells ignore it because being unable to exit is worse than being sandwiched.',
    ],
  },
  'pump-export': {
    what: 'From 2026-09-25, signing in to pump.fun on the web uses email or a social login, and pump holds a wallet for accounts made that way. The app talks to pump through its API using a wallet key, which pump says the change does not affect. Export that wallet’s key on pump.fun and import it here, and the app signs in to the same account. The username, followers and past calls come with it; nothing is created or renamed.',
    steps: [
      'On the pump.fun website: profile icon → View Wallet → Export Wallet. In the pump.fun phone app: Profile → menu → Settings → Export Wallet.',
      'Copy the private key (base58, or a JSON byte array).',
      'In Krypto Bot, open Automation → pump.fun accounts → Bring an existing account. Paste the key, add a label if you like, and press Import and sign in. Import on Wallet Utilities → Wallet list does the same thing.',
      'Check the result: an existing account shows its name and followers. If pump had no account for that key, signing in created one.',
      'If it says imported, but not signed in yet, sign it in from the Already on pump.fun list.',
      'For Auto-callout to post from this account, make it the trading wallet. This is refused while Live is armed, so switch to Paper first.',
      'In Callout rewards, accept pump’s reward terms for this account. If you will withdraw USDC, set its withdrawal address on Sol Wallet.',
    ],
    details: [
      {
        heading: 'What importing does',
        lines: [
          'The key is stored like any other: encrypted by the system keystore, never logged and never shown on screen. It counts toward your 15 wallets, and a key already in the app is refused.',
          'pump links an account to its wallet address. The app signs pump’s login message with the key, which logs in to that account. No transaction is sent and nothing is charged.',
          'Before signing in, the app looks up the address on pump’s public profile. It shows an existing account (name and followers), pump’s own placeholder record (sign in to use it), or no account (Create account). If the lookup fails, it shows unknown, never no account.',
          'After sign-in the app registers the account, tries the kryptcc referral, and puts Using krypt.cc/bot in the bio if the bio is empty. A bio with text in it is not changed.',
        ],
      },
      {
        heading: 'Sessions and the 25 September change',
        lines: [
          'The in-app pump.fun web sign-in window was removed on 2026-09-23 because Google refuses sign-in inside an embedded browser. Exporting and importing the key is now the way in.',
          'Callouts, follows, likes and profile edits all go through pump’s API, which pump says the 25 September change does not affect.',
          'A session lasts about 14 days. Sessions marks it with 3 days left, and Renew signs in again. pump ends a session by refusing it (a 401).',
          'An older account usually answers the referral with accountPredatesProgram or applyWindowClosed, and is left as it is.',
          'Sign-in-only accounts from the old web window can still be signed out. No new ones can be created.',
        ],
      },
    ],
    careful: [
      'pump.fun only shows this key on its own Export Wallet screen. Any DM, email or website asking for it is a scam.',
      'Anyone with the key controls the wallet and the pump.fun account. Paste it only into Krypto Bot, and never into a chat, a screenshot or a recording.',
      'After importing, the app can trade from that wallet. Back it up from Sol Wallet → Backup & removal, and keep only what you can afford to lose in it.',
    ],
  },
  automation: {
    what: 'Automation holds everything that trades off something other than your click: Copy Simple, Copy Trading, Scripts, Auto-callout, pump.fun accounts, AI connection and Farming (not built yet). Copy Simple and Copy Trading edit the same copy configs in one store and one engine (at most 25 configs). Scripts are rules or sandboxed JavaScript that ask the engine to act, and each ask is checked against that script’s own budget. The AI connection is a loopback MCP server that takes intents, not transactions. All of them go through the same buy/sell pipeline as the buttons, so the same fees, signer policy and breakers apply.',
    steps: [
      'Find a wallet on the Wallet Scout. Sort by Copy score over the default 7-day window and use the No bots, Enough trades, You could have copied, Holds over a minute and Trades most days filters.',
      'Press Follow on paper in the Scout drawer, or paste the address into Copy Simple. Either way the config is saved as paper.',
      'Open the same row on Copy Trading to set Direction (Copy / Reverse / FOMO), Copy with (the signing wallet), filters, its own exits and the three limits: Daily loss limit, Daily trade limit and Copies per minute.',
      'For signals a copy config cannot express, write a script. Use a leaderTrade rule or handler for followed wallets, or launchUpdate / runner for the scanner.',
      'Set each script’s budget before its logic: Max per trade, Buys per day, Daily loss stop, Open positions, Actions / min.',
      'Run everything on paper. Read Recent copies (skips included), the latency panel and each script’s log.',
      'Arm live one config or script at a time. Saving as live leaves it disarmed, and arming is a separate confirmed click.',
      'Keep the Scripts kill switch in reach. It turns every script off, and none can be enabled until it is lifted.',
    ],
    details: [
      {
        heading: 'Directions',
        lines: [
          'Copy: buys when they buy and mirrors their sells as a share of what you hold. Its own take-profit, stop-loss and max hold are off unless you set them (blank = off).',
          'Reverse: their sell is your entry and their buy-back is a 100% exit. The position also closes on its own exits, which default to +25% / −20% / 30 min.',
          'FOMO: follows a set of wallets and buys when Wallets to trigger (default 3) distinct wallets buy the same coin Within (default 180 s). Solana only.',
          'FOMO exits when the share of trigger wallets set in Exit when the crowd leaves (default 50%) has sold, or on its own exits (same 25 / 20 / 30 defaults).',
          'Trailing stop is opt-in on every direction and is measured from the peak since entry.',
          'Bounds: take-profit 1–1000%, stop-loss 1–95%, max hold 1–1440 min, trailing 1–95%.',
        ],
      },
      {
        heading: 'Paper is the default, and it is harsh',
        lines: [
          'Both Copy Simple and Copy Trading create paper configs. A live config comes back disarmed after a restart.',
          'A paper copy fills at the price after your configured Delay, not at the leader’s price.',
          'A paper round trip pays 1.5% on each side (pump’s 1% plus Krypt’s 0.5%).',
          'Paper follows the live staleness rules. An entry more than 60 s old (plus your delay) is refused, and so is an entry the leader already exited before it went out.',
          'Paper and live stats are scored separately. A row is governed by the mode it was opened in, not by what the config is set to now.',
        ],
      },
      {
        heading: 'The same pipeline everywhere',
        lines: [
          'Copies, script trades and AI-connection trades all reach the engine’s own buy/sell path. Fees are injected at signing.',
          'Every filter refusal is recorded as a skipped row or log line with its reason, so a scorecard never hides what a filter kept you out of.',
          'An unknown fact never passes a filter. A copy filter whose fact cannot be read refuses the copy, and a rule condition on an unknown value does not hold.',
          'Scripts can only sell positions that script opened. bot.positions() and the held field refer to that script’s own positions.',
        ],
      },
      {
        heading: 'Limits you set',
        lines: [
          'Copy config defaults: 0.05 fixed size, Max per trade 0.1, Min liquidity $5,000, Max slippage 15%, Daily loss limit 0.25, Daily trade limit 20, Copies per minute 10.',
          'Copy config bounds: Max per trade up to 25, delay 0–60 s, daily trades 1–500, copies per minute 1–120, proportional size up to 500%.',
          'Script defaults: Max per trade 0.05, Buys per day 20, Daily loss stop 0.5, Open positions 5, Actions / min 30.',
          'AI connection defaults: Max per buy 0.1, Max in an hour 0.5, Trades a minute 4.',
        ],
      },
    ],
    careful: [
      'The app’s own research found that copying wallets loses money on average. The best Copy score decile still lost about 1–3% per copied trade, and adding wallets to a crowd (FOMO) made the follower’s result worse: −15% to −32% after 60 min.',
      'Reverse has never been measured. It is a bet that the coin keeps going after the leader leaves.',
      'A live config or script keeps spending on its own while you are away. The daily limits are the only thing that stops it.',
      'Switching a copy config from live to paper does not close a live position it already opened. The leader’s later sells are recorded as not executed, and the tokens stay in your wallet.',
    ],
  },
  'copy-trading': {
    what: 'Each followed Solana wallet gets its own live-socket subscription. Its swaps are decoded from the transaction’s own balance changes, so trades routed through Jupiter, Raydium or Meteora are seen, not just pump.fun curve trades. On Robinhood Chain and BNB, followed wallets are seen only through that chain’s scanner poll, and only their launchpad-curve trades (Pons, four.meme). A copy config has its own signing wallet (Copy with), sizing, filters, delay, exits and limits. Copy Simple asks three things and derives the whole config from them, and Copy Trading shows every field of the same config.',
    steps: [
      'Rank candidates on the Wallet Scout by Copy score, which estimates what a follower would have made, not what the wallet made. Open the drawer and check the Reachable count and the bot, thin, unreachable and concentrated flags.',
      'Follow on paper from the Scout or from Copy Simple. Copy Simple sets fixed sizing at your per-trade size (0.05 / 0.1 / 0.25 / 0.5, or up to 5), Max per trade equal to that size, a daily loss limit of 10× the size, copy sells on, and paper.',
      'Open the config on Copy Trading. Set Copy with (a wallet other than your active one if you want), Sizing (fixed, or % of their size with Max per trade as the ceiling), Delay and Max slippage.',
      'Add filters: Their trade at least / at most, Max buys per token (1 = buy once), Never copy these tokens / creators (up to 100 each), Min / Max market cap, Token at least / at most (minutes old), and Mirror sells of at least (% of their bag).',
      'Clear any fact-based filter you do not need (Min liquidity, market cap, Min Krypt score, token age, creator blocklist, Pump.fun only). With none set, the token-facts lookup is skipped entirely.',
      'Watch Where a copy’s time goes and Recent copies for a few days. Recent copies includes the copies your filters rejected.',
      'Arm live only once the paper record justifies it. Live refuses a copy over the live per-trade ceiling and while live execution is blocked.',
    ],
    details: [
      {
        heading: 'How sells are mirrored',
        lines: [
          'A live copy stores the exact token amount its confirmed buy delivered and sells exactly that quantity, not a percentage of a balance shared with other bags.',
          'The amount a sell moved is read first from the fill’s own token change. If that has not reconciled within 8 s, it is read from a before/after balance.',
          'If the leader’s sold fraction cannot be decoded, the app reads their current holding: sold ÷ (after + sold). If that also fails, nothing is sold, and you get an error toast and a skipped row.',
          'A sell that arrives while your buy is still in flight is parked. If your buy was not yet submitted, it is abandoned. If it was already sent, the parked sell closes the position as soon as it opens.',
          'A leader sell more than 15 min old is not mirrored. It is recorded, and you still hold the position.',
          'While live copies are open, a balance sweep runs every 90 s. A copy is closed if its coin has left the wallet (with a 90 s grace after the buy), claimed quantities are cut down to what the chain holds, and a closed row still holding more than 0.5% is flagged as a leftover.',
        ],
      },
      {
        heading: 'Missed trades and recovery',
        lines: [
          'A transaction that arrives as a signature only (the logs transport) is read back with up to six attempts, with gaps of 120 / 300 / 800 / 2000 / 5000 ms.',
          'A trade that is never readable is counted as unreadable on the wallet’s status line, and it was not copied.',
          'Gap recovery fetches up to 25 recent signatures from the last 30 min, drops any already seen, and replays them oldest first. It runs when a subscription reconnects and as a routine check every 5 min per wallet (one wallet per 60 s tick).',
          'A recovered trade is still subject to the age rules: an entry more than 60 s old (plus your delay) or a sell more than 15 min old is recorded, not traded. Recovered trades are left out of the latency figures.',
        ],
      },
      {
        heading: 'Copy latency panel',
        lines: [
          'Where a copy’s time goes shows the median over this session’s copies, paper and live, measured from the leader’s own block time.',
          'Columns: Their fill → ours, Heard about it (detect), Read the tx (read-back), Decode, Checks (with the token-facts lookup counted separately inside it), Your delay, Our order (build + land).',
          'A stage that did not happen shows a dash, never zero. Paper has no order stage, and the tx transport has no read-back.',
          'Under five timed copies, the panel says the sample is too small to read. The Console carries one timing line per copy.',
          'Helius transactionSubscribe (tx transport, paid plans) delivers the whole transaction with the notification and removes the read-back stage.',
          'Both subscriptions use confirmed commitment. processed would save about 400 ms but can report a transaction that never lands.',
        ],
      },
      {
        heading: 'FOMO internals',
        lines: [
          'The crowd comes from Followed wallets, Saved Scout wallets, Tracked wallets, or Top Scout wallets by Copy score (Top N, default 25, range 2–200). Each set is re-read every 30 s.',
          'Every trade on the pump curve firehose is checked against the union of all enabled FOMO sets, cached for 30 s, so a wallet nobody watches costs only one lookup.',
          'A wallet heard on both the firehose and its own subscription counts once. At most one entry fires per coin per window, and never while a position in that coin is open.',
          'The entry goes through the normal filters, sizing and delay. Proportional sizing uses the crowd’s average buy, and the row lists the wallets that triggered it.',
          'Bounds: 2–50 wallets, window 10–3600 s, crowd exit 1–100%.',
        ],
      },
      {
        heading: 'The Copy score',
        lines: [
          'A follower’s entry and exit are each priced at the first trade at or after the leader’s time + 2 s. Each side pays 1.5%. Slippage is not modelled, so the figures are generous.',
          'A trip is unreachable if the leader was out before the follower was due (too fast), if no trade came before they sold (no entry), or if no exit trade came within 10 min (no exit).',
          'The five checks and their weights: follower median return (3), follower win rate (2), reachable trips (2), active days (1), coins per trip (1).',
          'There is no score under five closed trips or three resolved checks. A −3% median maps to about 60, so a mid-range score is where the best measured wallets land.',
          'Holds under 60 s are treated as uncopyable, and a wallet is flagged too fast when 50% or more of at least 5 trips were that short.',
        ],
      },
      {
        heading: 'What it cannot mirror',
        lines: [
          'Transfers, liquidity moves and claims are not swaps and are ignored. A leader who moves tokens to another wallet and sells from there triggers no sell.',
          'Round trips faster than your detect-to-land time are over before your copy lands.',
          'On EVM chains, only curve trades are seen, and nothing is seen while that chain’s scanner is stopped. FOMO does not run on EVM chains.',
          'Leader sells of tokens bought before you started watching count on their record but are never scored.',
        ],
      },
    ],
    careful: [
      'Copying loses on average in this app’s own data: 9.3 M trades, no follower decile was positive, and the best lost about 1–3% per trade. A high Copy score means least bad, not profitable.',
      'Every fact-based filter blocks the copy when the fact is unknown. The default $5,000 Min liquidity alone refuses any coin whose liquidity cannot be read.',
      'A sell smaller than Mirror sells of at least is not mirrored, and the rest of that position waits for their next sell.',
      'If a confirmed mirrored sell moves less than it asked for, the copy stays open for the remainder. Watch for leftover flags.',
      'Scripts are the only way to trade from several of your own wallets. The app does not space those trades or cap wallets per coin. Buying the same coin from many of your wallets can be wash trading.',
    ],
  },
  'scripts-deep': {
    what: 'A script is either a rule set (when a trigger fires and all conditions hold, run up to 8 actions) or JavaScript run in a hidden sandboxed window. The sandbox has no Node, no network (every request is cancelled, WebRTC blocked), no keys and no files, and it talks to the app only through bot.* calls. Every call is checked against that script’s budget and sent through the same trade pipeline as a hand-placed order. Each script runs on one chain (Solana / Robinhood / BNB tabs), and amounts are in that chain’s coin (bot.nativeSymbol).',
    steps: [
      'Pick the chain on New first. The Runner, Price tick, Order changed and Alert fired triggers are Solana only, and so are the order, alert and template actions.',
      'Start a rule, start a script, or start from an example. For AI-written code, paste Reference → Copy AI prompt into the assistant. That prompt is generated from the same tables the app runs on.',
      'Declare settings in an @inputs block: a JSON object inside a comment at the top, up to 24 fields. Read them as bot.input.<name>.',
      'Set the budget: Max per trade, Buys per day, Daily loss stop, Open positions, Actions / min.',
      'Run on paper. The log gives the first failed condition for rules and each refusal reason for trades.',
      'Switch to Live and press On. The confirmation names the per-trade, per-day and loss limits. Saving as live disarms the script, and On only works on a saved script with no unsaved edits.',
    ],
    details: [
      {
        heading: 'Budget and limits',
        lines: [
          'Defaults and bounds: Max per trade 0.05 (0.001–50), Buys per day 20 (1–500), Daily loss stop 0.5 (0.01–100), Open positions 5 (1–50), Actions / min 30 (1–120).',
          'A buy over Max per trade is refused, never shrunk. Always check r.ok and r.message.',
          'Realised loss past the Daily loss stop disables the script. On paper the figure is exact. On live it is estimated from the position’s PnL at the moment of each sell.',
          'Actions / min is charged once per bot.* action call. sellAll counts as one action however many positions it closes.',
          'Five errors in a row disable a code script. A handler is checked at 3 s, given more time while it is waiting on bot calls, and stopped at 30 s.',
          'A live script never comes back armed after a restart. The kill switch is saved, and while it is on nothing can be enabled.',
        ],
      },
      {
        heading: 'Key bot.* calls',
        lines: [
          'bot.buy(mint, sol, address?) and bot.sell(mint, pct, address?) run in the script’s mode. The optional address names one of your other wallets (Solana only), and only after you accept “Trading from your other wallets”.',
          'bot.subscribe(mint) streams ticks without pinning and costs no action. bot.watch(mint) also pins the coin to the Watchlist and costs one action.',
          'bot.order({mint, kind, triggerBasis, triggerValue, amount}) places a real advanced order: stop_loss, take_profit, trailing_stop, limit_buy, limit_sell, sell_on_dev_sell, sell_on_migration or buy_on_migration.',
          'bot.clearCompletedOrders() removes finished orders so the 200-order cap does not start refusing new ones. It costs no action and is Solana only. Call it every loop in a long-running script.',
          'bot.discord(\'fieldName\', embed) takes the name of a webhook-type @inputs field, never a URL. Only Discord hosts are accepted, bot.input shows the URL redacted, it works on paper, and it costs one action.',
          'bot.callout / bot.calloutReply post publicly on pump.fun with a line saying krypt.cc posted it. A script will not call the same coin from the same account twice in one run. Nothing is posted on paper.',
          'Reads: bot.token, bot.market (slow), bot.links (free), bot.security and bot.creator (one action each), bot.analyze (spends your AI key, 20/hour per script, cached 10 min), bot.positions, bot.orders, bot.runners, bot.leaders, bot.wallet, bot.wallets.',
          'State: bot.getState / bot.setState keep up to 16 KB of JSON across restarts. bot.stat / bot.stats set the widget and cost nothing. bot.every takes 5–3600 s; bot.at(\'HH:MM\') runs daily.',
        ],
      },
      {
        heading: 'Events',
        lines: [
          'The events are launch, launchUpdate, runner, position, tick, leaderTrade, order, alert, fill, schedule and interval. A script’s handlers run one at a time.',
          'launchUpdate fires at most once per 2 s per token. The event queue holds 50 events and drops launch chatter first.',
          'launchUpdate keeps firing only while a coin is tracked: during the 15 s evaluation window, for 15 min after a runner flag, while held, or while subscribed or watched. Call bot.subscribe(mint) on a runner you plan to act on.',
          'position fires about every 5 s for each held position and on every fill. tick fires at most once a second per token.',
          'leaderTrade carries leaderWallet, leaderLabel, leaderSide, leaderSol and leaderSoldPct for wallets followed on Copy Trading.',
        ],
      },
      {
        heading: 'Variables that trip people up',
        lines: [
          'score is computed once, when the launch is decided, and never changes after that. The median is 47, the 90th percentile 63, and about 1 launch in 36 scores above 80.',
          'uniqueBuyers counts raw distinct addresses since the launch was detected. Linked wallets, bundles and wash trades are not merged. It stops rising after the 15 s decision unless the coin stays tracked, and on BNB and Robinhood it covers only the latest 60 s or 120 s window.',
          'buyerAcceleration divides distinct buyers in the second half of the evaluation window (15 s by default) by those in the first half. A wallet that buys in both halves counts in both. It is 2 when only the second half has buyers, fixed once the window closes, and Solana only.',
          'creatorSold = false only means no creator sell has been seen yet. About 1 launch in 6 turns true.',
          'curveRegime (classic / mixed / unknown) matters because mixed curves carry most of the post-flag loss. isMayhem marks pump mayhem-mode coins.',
          'Link, X, Telegram, domain and site fields are null until someone opens the coin in the Links panel or a script calls bot.links(mint). They are Solana only.',
        ],
      },
      {
        heading: 'Unknown values',
        lines: [
          'A condition on an unknown (null) field never holds, and the log reports it as “<field> unknown”.',
          'In code, test for null yourself: if (t.score === null || t.score < 70) return; — writing (t.score < 70) alone lets an unknown score through.',
          'costSol is null, not 0, when the cost basis is unknown, so a rule on cost cannot fire on a position that looks free.',
        ],
      },
    ],
    careful: [
      'Advanced orders from a paper script are only written to its log, not placed. Callouts, replies, follows and likes send nothing on paper. Paper tests your filters and trading, not the posting.',
      'The script’s own Max per trade is the only size cap. The app’s manual per-trade cap does not apply to scripts.',
      'Trading from other wallets by address has no spacing and no per-coin wallet cap from the app. Buying one coin from many of your own wallets can be wash trading.',
      'A script that waits for score to rise will never buy, because the score never changes after the decision. Use the flow fields instead.',
      'A live script spends by itself around the clock. Scripts have no backtest, so test on paper against the live feed.',
    ],
  },
  ai: {
    what: 'The AI connection is an MCP server inside the app, bound to 127.0.0.1 (default port 8787, path /mcp) and protected by a bearer token. Its tools take intents such as “buy 0.1 of this coin”, never transactions, fees, endpoints or settings, and every tool refuses unknown fields. buy_token and sell_token reach the same buy and sell path the buttons use, which ends in the signer that adds the Krypt fee, so no tool can produce a signature without the fee.',
    steps: [
      'Open Automation → AI connection and turn the switch on. It starts at Read only.',
      'Choose how far it reaches: Off, Read only, Paper trading or Live trading. Live asks you to confirm “Let an AI spend real funds?”.',
      'Press Copy the connect command, which copies claude mcp add --transport http krypto-terminal http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>". Or use Copy it as JSON.',
      'Before going live, set Max per buy, Max in an hour and Trades a minute.',
      'Have the assistant call get_wallet first. It reports the connection mode, and the assistant should state that mode in every report.',
      'Run it on Paper trading, then compare get_trade_history with what you expected before moving to Live.',
      'If the token leaks, press New token. Clients using the old token stop working at once.',
    ],
    details: [
      {
        heading: 'Access levels',
        lines: [
          'Off: the server answers 503 whatever token is sent.',
          'Read only: the 13 read tools. Trade tools are neither listed nor answered.',
          'Paper trading: adds the 4 trade tools. Fills are simulated into the paper book, nothing is bought, and no fee is paid.',
          'Live trading: real funds, within the limits.',
          'The level is re-read on every request, so a change takes effect on the next call. It is checked before arguments, so a read-only client learns nothing about trade-tool fields.',
          'The access level and token cannot be changed by a settings change, only from this page.',
        ],
      },
      {
        heading: 'Limits',
        lines: [
          'Max per buy (default 0.1, up to 25), Max in an hour (default 0.5, up to 100), Trades a minute (default 4, 1–60). Max per buy cannot exceed Max in an hour.',
          'The value limits apply only in Live. The per-minute limit applies to trades at every level.',
          'Sells are never limited by value. A limit buy counts against the buy limits; a stop loss does not.',
          'Each attempt reserves its slot before the app is asked, so two buys at once cannot both slip through. A refused trade still uses its slot until the window rolls over.',
          'Changing the access level resets the counters.',
        ],
      },
      {
        heading: 'Tools',
        lines: [
          'Read: get_wallet, get_positions, get_token, find_tokens, get_wallet_scores, get_wallet_record, get_copy_configs, get_orders, get_trade_history, get_chart, get_token_links, get_runner_alerts, get_callouts.',
          'Trade: buy_token (mint, amount, chain), sell_token (mint, percent 1–100, chain), place_order (stop_loss, take_profit, trailing_stop, limit_buy, limit_sell; limit orders do not accept a percent trigger), cancel_orders.',
          'Most tools accept chain = solana, robinhood or bnb. place_order, cancel_orders, get_chart, get_token_links and get_callouts are Solana only and refuse a chain argument.',
          'Answers carry their caveats: null means unknown, the Copy score ranks least bad, and trade history is read from the chain with fees included.',
        ],
      },
      {
        heading: 'How the connection is locked down',
        lines: [
          'The server listens on 127.0.0.1 only, and no setting changes that.',
          'The token is 32 random bytes (64 hex characters), compared in constant time.',
          'A request from a web page that is not on this computer gets 403, which blocks DNS-rebinding from open browser tabs.',
          'Requests are capped at 256 KB, and there is a single /mcp path.',
        ],
      },
      {
        heading: 'What it can never do',
        lines: [
          'It has no withdraw, transfer, send, bridge, token launch, or wallet create / import / export.',
          'It cannot change any setting, including fees, treasury, referrals and RPC, and it cannot arm a copy config (it can read them).',
          'It never sees a key, has no raw RPC access, and cannot hand the app anything to sign.',
        ],
      },
    ],
    careful: [
      'The copied command contains the bearer token. Anyone who has it can drive the connection at its current level, so press New token if it leaks.',
      'Live lets an assistant trade real funds unattended. Nobody has shown an AI trading this app profitably, and the app’s own research found copying wallets loses on average.',
      'Paper runs with no value limits, so a paper record can include sizes that live would refuse.',
      'Placed orders are real. An assistant’s stop loss or limit order fires later without the assistant.',
    ],
  },
  pumpfun: {
    what: 'pump.fun ties an account to a wallet address, so signing in with a wallet’s key IS logging in to that address’s account. The app signs pump’s login message with the wallet, trades it for a bearer session at pump’s API, and keeps one session per wallet, all live at once. Signing in with an address pump has never seen creates its account there and then; it sends no transaction and costs nothing. Accounts signed in through the old pump.fun web window (no key in the app) can post and like but never trade; no new ones can be made.',
    steps: [
      'Open Automation → pump.fun accounts. The lists split your wallets into Already on pump.fun (Sign in, or Sign in all N) and Accounts to make (Create account, or Make all N), using pump’s public profile read.',
      'To bring an account you already use elsewhere, paste its wallet key under Bring an existing account. The import and the sign-in happen in one step, and the username, followers and past calls come with it unchanged.',
      'Name several accounts at once under Names: one name per line, applied in the order the accounts are listed. A list with the same name twice is refused before anything is sent.',
      'Edit a single profile (username up to 15 characters, bio up to 250) from the Wallet page. The bio always ends with a fixed “Using krypt.cc/bot” line, so your own words get what is left.',
      'Watch Sessions. Anything with 3 days or less left is marked, and Renew N signs all of those in again in one press.',
      'Press a wallet’s stats to read what pump says about you as a caller — Today, This week, This month and All time — with the share of calls whose peak reached 1.2×, 1.5× and 2×, the average and median peak, and the time to peak.',
      'Use Follow or like to act as one of your accounts, or call bot.follow / bot.like from a script.',
    ],
    details: [
      {
        heading: 'Sessions',
        lines: [
          'A session lasts about 14 days. That is observed from pump’s own token, not a promise pump publishes, so the app never expires one itself.',
          'The only authority is pump’s server: a 401 on a profile read turns that session into a signed-out one.',
          'The Sessions list shows the days left on each, and flags any session with 3 days or less so nothing lapses mid-run.',
          'A lapsed session shows up first as a script’s callouts failing. Renew before that happens.',
          'pump drops wallet sign-in on its website on 2026-09-25 15:00 UTC. API sessions, which this app uses, and trading are not affected.',
        ],
      },
      {
        heading: 'Making and naming accounts',
        lines: [
          'An account that was signed in through the API is registered with pump right after, which is required before follows and likes work.',
          'Usernames are almost certainly unique on pump, and pump decides whether it accepts each one. A rejected name is reported per account.',
          'Names from a list are applied only to accounts that are signed in, and a list longer than the number of accounts is refused.',
          'The bio line is deliberately NOT rotated: a bio is a saved profile field, not a repeated post, so re-saving an unchanged bio stays a no-op.',
        ],
      },
      {
        heading: 'Referral',
        lines: [
          'Every account made or signed in here is referred by Krypt on pump.fun with the code kryptcc. The notice is shown at the top of the accounts page.',
          'pump pays the referrer a share of the callout rewards the account earns, taken from the account’s own share. pump also pays a first-deposit match, which costs the account nothing.',
          'pump only accepts a referral inside a window after sign-in (24 h observed), so an account that already existed before the app may never be referred. That is logged and left alone.',
        ],
      },
      {
        heading: 'Follows, likes and limits',
        lines: [
          'Follow, unfollow, like and unlike run as the account you pick. They are public: a follow shows on the other account’s follower list and a like on the callout.',
          'Calls from one account are spaced at least 1.2 s apart so a script looping over a list does not trip pump’s limiter. That is spacing, not a cap on how many.',
          'Those old sign-in-only accounts are not counted against the wallet limit, because the app can never trade with them.',
        ],
      },
    ],
    careful: [
      'Everything an account does here is public and under its name: callouts, follows, likes and the bio line.',
      'The wallet key IS the account. Anyone with the key can sign in as you, post as you and trade the wallet.',
      'The referral takes Krypt’s share out of the account’s callout rewards. It is disclosed on the accounts page and in the terms.',
      'Running many accounts to boost one coin can break pump.fun’s rules and can be market manipulation. The app does not stop you; the responsibility is yours.',
    ],
  },
};
