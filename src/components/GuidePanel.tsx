// The guides — what this app expects you to know, written down.
//
// Deliberately not a feature tour. Each entry answers a question someone
// actually has while losing money or about to: where does my SOL go, why did
// this sell fail, what is the difference between the two modes, what will
// this order do at 3am when I am asleep. The numbers in here are the ones the
// code uses; if one changes, this file changes with it.
//
// Kept in one place so the honest bits (fees, what is measured, what is not)
// cannot drift apart from the pages that make the same claims.

import { useState } from 'react';
import { ChevronRight, PlayCircle } from 'lucide-react';
import { Card, Section } from './common';
import { cls } from '../utils/format';

export interface Guide {
  id: string;
  title: string;
  summary: string;
  /** Paragraphs and bullet blocks, in order. */
  body: Array<string | string[]>;
}

const GUIDES: Guide[] = [
  {
    id: 'start',
    title: 'Getting started, in order',
    summary: 'Wallet, funding, first trade — and what to do before any of it',
    body: [
      'Create a wallet on the Wallet page. It is generated here and encrypted by your operating system; nobody, including us, can recover it. Back the key up somewhere safe BEFORE you put money in it.',
      'Fund it with what you can afford to lose. This is a hot wallet on a desktop, not cold storage. Set a max-balance cap and a withdrawal address on the same page while you are there.',
      [
        'Once a wallet exists the app is in LIVE mode: a trade you place spends real SOL.',
        'Switch to Paper in the top bar if you want to practise first. Everything works, nothing is sent.',
        'Live execution must also be armed before anything signs.',
      ],
      'Open a token from Discover, or paste a contract address with Ctrl+K. The trade panel shows the all-in cost before you commit.',
    ],
  },
  {
    id: 'costs',
    title: 'What a trade actually costs',
    summary: 'Our fee, their fees, and the SOL you must keep back',
    body: [
      'Krypt takes 0.5% of each side of a trade, so a round trip pays it twice. It is charged on the same transaction and shown in the cost breakdown before you click. Nothing else is charged: no subscription, no ads, no data sale.',
      [
        'pump.fun charges 1% of its own on curve trades. Not ours.',
        'A priority fee and, in Fast mode, landing tips go to validators. Not ours.',
        'A token account costs about 0.002 SOL in rent, which you get back with Sweep rent after selling.',
        'The relayer adds 0.5% when the local builder cannot be used — which is why the local builder is the default.',
      ],
      'Every buy holds back about 0.015 SOL so the position can be sold again. A sell pays its network and priority fee BEFORE the swap can return any SOL, so a wallet emptied by a buy cannot afford its own exit. If a buy gets trimmed for this reason the app says so.',
    ],
  },
  {
    id: 'modes',
    title: 'Paper and Live, and what arming means',
    summary: 'Two switches, and why both exist',
    body: [
      'The Paper/Live switch in the top bar decides whether a trade is simulated or real. Paper fills against live prices and keeps its own book, so the numbers are honest but no SOL moves.',
      'Arming is separate. Live execution must be armed before the app will sign anything, and it disarms itself when a loss breaker trips, when a decoder drifts, or when you switch wallets. A disarm flips the persisted mode back to Paper, so an app that lost its footing never quietly resumes trading.',
      'Nothing here decides to trade on its own. The scanner flags tokens and tells you; you decide. The only things that execute without a click at that moment are advanced orders you wrote yourself, which is the entire point of a stop loss.',
    ],
  },
  {
    id: 'orders',
    title: 'Orders and auto-sell',
    summary: 'Stops, take profits, and arming the same exit every time',
    body: [
      'The Orders page writes stop losses, take profits, trailing stops, limit orders on price or market cap, and triggers such as sell-if-the-creator-sells. Paste a mint and the same form the token page uses appears.',
      'Auto-sell templates arm a whole exit plan the moment a manual buy lands, so you stop typing the same stop out per token. Three ship (Runner, Scalp, Stop only); editing one saves a copy you own.',
      [
        'Template orders are ordinary orders: they appear in the list, you can change or cancel them.',
        'Each take-profit step sells a share of what is LEFT, so a ladder can never oversell a position.',
        'Buying the same token twice does not arm a second ladder.',
      ],
      'Orders survive a restart but come back PAUSED, never silently re-armed — a stop must not fire into a market the app was not watching. The Orders page says so in gold when it happens; review, then resume.',
    ],
  },
  {
    id: 'exits',
    title: 'When a sell will not go through',
    summary: 'The three real causes, and what to do about each',
    body: [
      'Not enough SOL for fees. The most common one. A sell pays its fee before the swap returns anything, so a wallet with almost nothing left cannot exit. Send about 0.01 SOL to the trading wallet and try again. The app now says this in plain words rather than showing a transaction error.',
      'The price moved further than your slippage. The first attempt goes at your setting, floored at 15%. If it does not land, the retry automatically goes wider (up to 50%), because being stuck in a position you asked to leave is worse than a poor fill.',
      'No route or no liquidity. A rugged, frozen or fully dead token has nobody to sell to. Nothing can fix that, and any tool claiming otherwise is guessing.',
    ],
  },
  {
    id: 'mev',
    title: 'Sandwiching and how a trade is routed',
    summary: 'What Private mode does, and what it cannot promise',
    body: [
      'A public transaction sits in a mempool before it lands, where anyone can read it and trade in front of it. That is sandwiching, and it is the most common invisible loss on a Solana buy.',
      [
        'Public only — one RPC, no tips. Cheapest, most exposed.',
        'Fast (default) — public RPC plus staked and bundle lanes, tipped. Best landing odds, still public.',
        'Private — a BUY goes to the Jito bundle lane alone and is never broadcast publicly. It costs a tip and can miss a block.',
      ],
      'Selling always uses every lane, whatever the mode. Missing a block on the way out is worse than being seen on the way out.',
      'How much sandwiching Private actually avoids is unmeasured, and we do not show a protection score. Nobody can measure the trade that did not happen; a vendor showing you a shield with a percentage on it is guessing.',
    ],
  },
  {
    id: 'runners',
    title: 'Runners, and what the odds mean',
    summary: 'How a flag is decided, and why most still fail',
    body: [
      'Every launch the scanner sees is scored at 60 and 120 seconds with a graduation-odds model measured on 73,890 real launches. The ones landing in the top buckets are flagged and notified.',
      'The rate shown is what that bucket actually did on the measured day, and the base rate sits beside it so the odds against are never hidden. Most flagged launches still do not graduate. A flag is a place to look, not a signal to buy.',
      'Flags expire after 15 minutes: past that the launch has moved or it has not, and a stale list buries the ones that matter. Nothing is ever bought for you.',
    ],
  },
  {
    id: 'wallets',
    title: 'Multiple wallets',
    summary: 'Creator, Funder, Warmer, Copier — and the one rule',
    body: [
      'Automation holds four pages: create a group and fill it with wallets, fund them from your main wallet and collect back, warm a group with random trading under a hard loss cap, and have a group follow your manual trades or take a group-wide order.',
      'One wallet signs at a time — the active one — and switching is blocked while armed. Funding only ever moves SOL between wallets this install holds; the signer refuses any other destination, so a bug or a bad input cannot send it elsewhere.',
      'The warmer is a utility, not a strategy. It is expected to lose fees and slippage on purpose, and its loss cap counts realised losses on closed trades, with open bags carried at cost.',
    ],
  },
  {
    id: 'chat',
    title: 'Trading from your phone',
    summary: 'What the paired chat can and cannot do',
    body: [
      'Bring your own Telegram or Discord bot, pair it with a code, and that account becomes the only one it answers. Everyone else gets silence rather than a refusal, so a stranger cannot tell the bot exists.',
      'Trading from chat is OFF until you turn it on, and buying needs a second switch. Every spending command is quoted back and needs a one-time code within a minute. Buys are capped per trade and per hour; sells are never rationed.',
      'No command can withdraw, transfer, arm, or touch a key, and no command anywhere takes an address — so a stolen chat account cannot aim your SOL at a destination. /lock turns chat trading off from the phone.',
    ],
  },
  {
    id: 'sharing',
    title: 'Cards and replays',
    summary: 'Making something worth posting, honestly',
    body: [
      'Any closed trade on the Trades page makes a share card: what went in, what came out, how long you held. An open position can make one too, and it says unrealized on the artwork, because a green number on a bag you still hold is not a result.',
      'Replay animates the trade as it happened — candles arriving, your entry and exit marked, the PnL moving — and saves as a video in 16:9 or 9:16. Providers keep little history for dead tokens, so an old trade may have no candles left to animate.',
      'Backgrounds can be your own image or a GIF searched from GIPHY or Tenor, which needs a free key of your own in Settings. A PNG saves one frame; Save video keeps the motion.',
    ],
  },
  {
    id: 'privacy',
    title: 'What leaves this machine',
    summary: 'Honestly, including the parts that are not flattering',
    body: [
      'There is no account, no telemetry and no server of ours. Your key, your settings, your trades and your history stay on this computer.',
      [
        'Market data providers see which tokens you look at, and your IP. The privacy panel in Settings names every host and the master switch turns all of it off.',
        'Your RPC provider sees your transactions, as it must to send them.',
        'Token images are fetched through the app, so the image host learns your IP — that switch is separate.',
        'Chat bots, AI analysis and Discord presence are each off until you turn them on, and each is an outbound connection when on.',
      ],
      'Nothing about a trade is sent anywhere by us. The share cards and replays are rendered on this machine; they only leave if you post them.',
    ],
  },
  {
    id: 'trouble',
    title: 'When something is wrong',
    summary: 'Logs, crashes, and getting unstuck',
    body: [
      'The Grimoire page is the live log. About has buttons for the logs and crash folders, which is what to send if you report something.',
      [
        'A trade failing with an unreadable error: check the wallet has SOL for fees first.',
        'Orders paused after a restart: that is deliberate. Review and resume them.',
        'Charts or Discover empty: a provider may be rate-limited, or market data may be switched off in Settings.',
        'Holder lists needing a key: free RPCs refuse those lookups; a Helius key enables them.',
      ],
      'If the interface breaks, the engine keeps running. The crash panel can stop it, which disarms live execution and closes paper positions, and never sells your real holdings.',
    ],
  },
];

function GuideRow({ guide, open, onToggle }: { guide: Guide; open: boolean; onToggle: () => void }) {
  return (
    <div className={cls('rounded-lg border transition', open ? 'border-krypt-purple/40 bg-black/30' : 'border-white/8 bg-white/[0.02]')}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <ChevronRight className={cls('h-4 w-4 flex-shrink-0 text-krypt-muted transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="block text-value font-semibold text-white">{guide.title}</span>
          <span className="block text-body text-krypt-muted">{guide.summary}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-11">
          {guide.body.map((block, i) =>
            Array.isArray(block) ? (
              <ul key={i} className="space-y-1">
                {block.map((line, j) => (
                  <li key={j} className="flex gap-2 text-note leading-relaxed text-krypt-muted">
                    <span className="mt-[7px] h-1 w-1 flex-shrink-0 rotate-45 bg-krypt-purple/70" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p key={i} className="text-note leading-relaxed text-krypt-muted">
                {block}
              </p>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A guide block a PAGE can host, in the same visual language as the global
 * Guides section. Pages that need explaining should explain themselves where
 * the user is, rather than sending them to About and hoping.
 */
export function PageGuide({ title, description, guides }: { title?: string; description?: string; guides: Guide[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Section title={title ?? 'How this page works'} description={description}>
      <Card padded={false} className="space-y-2 p-3">
        {guides.map((g) => (
          <GuideRow key={g.id} guide={g} open={openId === g.id} onToggle={() => setOpenId(openId === g.id ? null : g.id)} />
        ))}
      </Card>
    </Section>
  );
}

export function GuidePanel() {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Section
      title="Guides"
      description="How this app expects to be used, and what it will not do for you. Written to be read before something goes wrong."
    >
      <Card padded={false} className="space-y-2 p-3">
        <button
          onClick={() => void window.krypt.app.openExternal('https://www.youtube.com/watch?v=pqIWxrocy68')}
          className="flex w-full items-center gap-3 rounded-lg border border-krypt-purple/40 bg-krypt-purple/10 px-4 py-3 text-left transition hover:bg-krypt-purple/20"
        >
          <PlayCircle className="h-5 w-5 flex-shrink-0 text-krypt-purple" />
          <span>
            <span className="block text-value font-semibold text-white">Watch the guide</span>
            <span className="block text-body text-krypt-muted">Everything below, in about ten minutes. Opens in your browser.</span>
          </span>
        </button>
        {GUIDES.map((g) => (
          <GuideRow key={g.id} guide={g} open={openId === g.id} onToggle={() => setOpenId(openId === g.id ? null : g.id)} />
        ))}
      </Card>
    </Section>
  );
}
