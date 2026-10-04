// Guides — one short guide for each part of the Hub, in plain words
// (2026-09-20). This page replaced Rewards; the reward check moved to the
// Robinhood and BNB wallet pages, where the wallet it is about lives.
//
// Written for someone who has never used a trading app: short sentences,
// one action per step, no jargon that is not explained in the same line.
// Each guide is three parts — what the section is, what to do there, and
// what to be careful about — because those are the three questions a
// person actually has. The long, detailed guides (fees, exits, sandwiching,
// privacy) still live below, for anyone who wants them.
//
// `SECTION_GUIDES` is keyed by workspace id and pinned by
// test/workspaces.test.mjs: every workspace on the Hub has a guide here, so
// adding a workspace without one fails a test rather than leaving a hole.
//
// The Advanced switch (2026-09-24) swaps every card for its power-user
// version from guidesAdvanced.ts: the mechanics, defaults and limits, read
// from the code. test/guides.test.mjs fails if a card has no advanced twin.

import { useEffect, useRef, useState } from 'react';
import { AtSign, BookOpen, ExternalLink, Flame, Bot, Code2, Coins, Compass, Cpu, KeyRound, Layers, LayoutGrid, Megaphone, Percent, PlayCircle, Rocket, Settings as SettingsIcon, Users, Wallet, type LucideIcon } from 'lucide-react';
import { WORKSPACES, type WorkspaceId } from '../workspaces';
import { Card, Page } from '../components/common';
import { GuidePanel } from '../components/GuidePanel';
import { cls } from '../utils/format';
import { AIO_WALLET_VIDEO_URL, API_KEY_SITES, API_KEYS_VIDEO_URL, GUIDE_VIDEOS, MEMECOIN_GUIDE_URL, PUMP_QUICKSTART_URL } from '../guideVideos';
import { ADVANCED_GUIDES, type AdvancedGuide } from './guidesAdvanced';

export interface SectionGuide {
  /** One or two short sentences. */
  what: string;
  /** Numbered steps, one action each. */
  steps: string[];
  /** Things that lose money or keys. Short. */
  careful: string[];
  /** A video walk-through, opened in the system browser. */
  video?: { url: string; label: string };
  /** Sites the steps send people to, opened in the system browser. */
  links?: readonly { name: string; url: string }[];
}

/** Whether the Advanced switch is on. A per-viewer convenience, so browser
 *  storage, and it must never break the page if storage is refused. */
const ADVANCED_KEY = 'krypt.guides.advanced.v1';
function readAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeAdvanced(on: boolean): void {
  try {
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0');
  } catch {
    /* the switch still works for this visit */
  }
}

const ICONS: Partial<Record<WorkspaceId, LucideIcon>> = {
  terminal: Compass,
  automation: Bot,
  engine: Cpu,
  wallets: Wallet,
  scout: Users,
  launch: Rocket,
  layout: LayoutGrid,
  system: SettingsIcon,
  guides: BookOpen,
};

/** Before any section: the three things to do first. */
export const START_GUIDE: SectionGuide = {
  what: 'This app helps you find new coins and buy or sell them. It can also trade for you, but only if you set that up.',
  steps: [
    'Open Wallet Utilities, then Wallet. Press the button to make a wallet. Write the key down and keep it somewhere safe.',
    'Send a small amount of SOL to that wallet. Only money you are fine losing.',
    'Open Terminal, then Discover. Click any coin to open its page.',
    'On the coin page, type an amount and press Buy. Start small.',
    'To get out, press Sell. 100% sells everything you have of that coin.',
  ],
  careful: [
    'Paper mode is practice with fake money. Live mode is real money. The switch is in the top bar. Check it before you click Buy.',
    'If you lose your key, nobody can get it back. Not even us.',
  ],
};

/**
 * Memecoins in general, before any button (2026-09-29), with krypt cc's
 * memecoin trading video. Honest numbers only: the graduation base rate and
 * the fee drag are the measured ones (docs/insight-swarm-2026-08-30.md,
 * docs/breakeven-swarm-2026-09-28.md).
 */
export const MEMECOIN_GUIDE: SectionGuide = {
  what: 'A memecoin is a coin with nothing behind it — no company, no product. Its price moves only because people buy and sell it. On pump.fun every new coin starts on a "bonding curve": the price goes up as people buy and down as they sell. If enough people buy, it "graduates" to a normal market. Only about 2 in every 100 new coins get that far. Most go to zero within hours.',
  steps: [
    'Before you start, pick an amount you are fine losing completely. Only ever trade with that.',
    'Split it up. Put a small slice into each coin, never the whole amount into one.',
    'Before you buy, open the coin page. Read the warnings and the Security tab. A creator who already sold, or one who has made lots of coins that all died, is a bad sign.',
    'Decide how you will get out before you get in: a price to take profit and a price to cut the loss. Set them as orders so they happen even if you look away.',
    'When a coin doubles, think about selling half. That takes your money back out, and the rest is free to ride.',
    'Check the Trades page now and then. It shows what you really made after every fee.',
  ],
  careful: [
    'A rug pull is when the creator or a big holder sells everything at once. The price can fall to almost nothing in seconds, before you can click.',
    'Fees add up. Krypt takes 0.5% on the buy and again on the sell, pump.fun takes 1% while a coin is on its curve, and the network charges a small fixed fee. On very small buys that fixed fee can be a big share of the trade.',
    'Nobody can tell you which coin will go up — not a Telegram group, not an influencer, not this app. A runner alert means "look at this", not "buy this". When we tested automatic strategies on real data, they lost money on average.',
    'Anyone who promises a sure thing, DMs you a coin, or asks for your key is trying to take your money.',
    'This is not financial advice.',
  ],
  video: { url: MEMECOIN_GUIDE_URL, label: 'Watch the memecoin trading guide' },
};

/**
 * The three free API keys, with krypt cc's walk-through (2026-09-29). Right
 * under Start here: the keys are the first thing after a wallet that makes
 * the app faster, and onboarding offers the same video on its keys step.
 */
export const API_SETUP_GUIDE: SectionGuide = {
  what: 'The app works with no keys at all. Three free keys make it better: Helius makes trades send and confirm faster and shows holders, Birdeye adds second-by-second chart candles, and Jupiter moves price quotes onto its main servers. Each takes a couple of minutes to get.',
  steps: [
    'Helius: open the Helius link below and sign up. On the dashboard, copy your API key. You can also copy the whole RPC URL — the app takes either.',
    'Birdeye: open the Birdeye link below and sign up. Copy the API key it gives you.',
    'Jupiter: open the Jupiter link below and sign up. Make a new API key and copy it.',
    'In the app, open Settings. Paste the Helius key under Solana RPC, and the Birdeye and Jupiter keys under Market data.',
    'Not sure where a button is? The video goes through all three, start to finish.',
  ],
  careful: [
    'A key is like a password for your account on that site. Do not post it in a chat, a screenshot or a video.',
    'Keys stay on this computer. They are never sent to Krypt.',
    'All three are free. If a site asks you to pay, you picked a paid plan — go back and choose the free one.',
  ],
  video: { url: API_KEYS_VIDEO_URL, label: 'Watch the API setup video' },
  links: API_KEY_SITES,
};

/**
 * The AI connection (MCP). A page under Automation since 2026-09-23 (it was
 * in Settings, where nobody found it), but still its own card, like Start
 * here: it is a thing people look for by name.
 *
 * Written for someone who has heard "connect an AI to it" and does not know
 * what that means. The two facts that matter are that it starts unable to
 * trade, and that even at its most permissive it cannot move money anywhere
 * except through a trade.
 */
export const AI_CONNECTION_GUIDE: SectionGuide = {
  what: 'You can let an AI assistant, like Claude Code or Codex, look at this app and — if you choose — trade through it. The way AI assistants plug into apps is called MCP. It can read your wallet, your positions, any coin, the charts, the scanner flags and the wallet records, on all three chains. It talks to this computer only. It starts off, and starts unable to trade.',
  steps: [
    'Open Automation from the Hub. In the menu on the left, press AI connection. Turn the switch on.',
    'Pick how far it reaches. Read only means it can look and nothing else. Paper means it can also trade with fake money. Live means real money.',
    'Under Connect a client, pick your AI app from the list and press Copy. The panel says where it goes.',
    'For Claude Code or Gemini CLI, paste the line into a terminal and press enter. For the others (the ChatGPT desktop app’s Codex, Claude Desktop, Cursor, VS Code and more), add the copied text to the file the panel names, then restart that app.',
    'Ask it something, like what am I holding, or look up this coin, or what did the scanner flag today.',
    'If you chose Live, set the three limits underneath: the most it can spend on one buy, the most in an hour, and how many trades a minute.',
  ],
  careful: [
    'The line you copy contains a password for your app. Do not paste it into a chat, a screenshot or a video. If it gets out, press New token — the old one stops working straight away.',
    'Live means an AI can buy and sell with your real money on its own. Nobody has shown that an AI trades this app profitably. Start on Paper and read what it did.',
    'It can never take your money out. There is no withdraw, no transfer and no send — the only thing it can do with your funds is trade them, and the coins land back in your own wallet.',
    'It also cannot change any setting, see your key, or hand the app something to sign. It asks; the app decides and builds the trade the same way the buttons do, with the same fee.',
    'It can drive a Krypto Trader session only if you picked MCP as that session’s driver, and only inside its budget and limits. It can never start, fund, resume or change a session, and a Paper connection cannot move a live one.',
    'Only AI apps running on this computer can connect. ChatGPT or Claude in a web browser or on a phone, the Gemini app, and other cloud AIs cannot reach it — that is on purpose. To use GPT-6 Astra, use it in the ChatGPT desktop app’s Codex or the Codex CLI.',
    'Turning the switch off closes the door immediately, even in the middle of a conversation.',
  ],
};

/**
 * Bringing a pump.fun account (email/Google/Apple/GitHub) into the app by
 * exporting its wallet key. Its own card, because from 2026-09-25 this is how
 * most people's pump.fun accounts get here, and they will look for it by name.
 *
 * The safety lines are the point: the key is only ever revealed on pump.fun's
 * own Export Wallet screen, and anyone with it owns the wallet.
 */
export const PUMP_EXPORT_GUIDE: SectionGuide = {
  what: 'If you made your pump.fun account with email, Google, Apple or GitHub, pump.fun holds a wallet for it. To use that account here — its name, followers, callouts and rewards — bring that wallet in by exporting its key from pump.fun and importing it. You only do this once per account.',
  steps: [
    'Open pump.fun in your normal web browser and sign in the way you always do (Google, email, Apple or GitHub).',
    'Click your profile picture at the top right, then choose View Wallet.',
    'Press Export Wallet. Confirm it is you if it asks. (On the phone app: Profile, then the menu, then Settings, then Export Wallet.)',
    'Copy the private key it shows — a long line of letters and numbers.',
    'In Krypto Bot, open Automation, then pump.fun accounts. Paste the key under Bring an existing account and press Import and sign in.',
    'Done. That account is now in the app: it can trade and post, and it no longer needs pump.fun sign-in to work.',
  ],
  careful: [
    'pump.fun asks for this key in exactly one place: its own Export Wallet screen. If a DM, an email, or any other site asks for it, it is a scam.',
    'Anyone who has this key controls that wallet and everything in it. Paste it only into Krypto Bot, and never share it or put it in a chat or screenshot.',
    'This is the way to keep using a pump.fun account here after pump changes its web sign-in on 25 September. Importing counts toward your 15 wallets.',
  ],
};

/**
 * pump.fun: what an account is here, in one card, with krypt cc's quickstart
 * video (2026-09-24). The same video is on the pump.fun accounts page.
 */
export const PUMP_GUIDE: SectionGuide = {
  what: 'On pump.fun, an account is a wallet. Every wallet in this app can have its own pump.fun account, with its own name, followers and callouts.',
  steps: [
    'Open Automation, then pump.fun accounts. Every wallet you have is listed there.',
    'Under Accounts to make, press Create account on a wallet that has none yet. It costs nothing and sends no transaction.',
    'Under Already on pump.fun, press Sign in to log in to a wallet’s existing account as it is.',
    'Give the account a name. You can type one per line to name several at once.',
    'Already have a pump.fun account with followers? Use Bring an existing account and paste that wallet’s key.',
    'A sign-in lasts about two weeks. The Sessions list shows how long each has left. Press Renew before it runs out.',
  ],
  careful: [
    'Callouts, follows and likes are public and under that account’s name.',
    'When a sign-in runs out, callouts from that account stop until you sign in again.',
    'Accounts made or signed in here are referred on pump.fun by kryptcc. pump pays Krypt a share of that account’s callout rewards, taken from the account’s share.',
  ],
  video: { url: PUMP_QUICKSTART_URL, label: 'Watch the pump.fun quickstart' },
};

/** The All-in-One wallet (6.0.0, 2026-10-03), with krypt cc's video. Every
 *  label here is the one on the page; the limits are the code's. */
export const AIO_WALLET_GUIDE: SectionGuide = {
  what: 'One wallet for Solana, BNB Chain and Robinhood, backed up by one 12-word recovery phrase and shown in dollars. Buy on any chain: if that chain is short, the buy first moves money over from your other chains, then buys.',
  steps: [
    'Open Wallet Utilities, then All-in-One Wallet. Press Create All-in-One wallet, or Use my recovery phrase if you already have one. The same phrase opens it in Phantom and MetaMask.',
    'Write the 12 words down on paper and keep them safe. Anyone who has them can take everything in the wallet.',
    'Switch the top bar to Paper, then press Use it on every chain. Now every buy and sell, on every chain, uses this wallet.',
    'Fund it. Under Receive there are two addresses: send SOL to the Solana one, and BNB or Robinhood ETH to the other — it is the same address on both chains. USDC sent to the Solana address is turned into SOL for you.',
    'In the top bar, pick ALL and switch it to Live. That turns on every chain at once. The dollar total at the top right is everything the wallet holds.',
    'Open any coin on any chain, type an amount and press Buy. If that chain is short, the button says Top up + buy and shows what the move costs. It moves the money, waits for it to land, then buys — usually in under 10 seconds.',
    'Want instant buys, and quick-buy buttons and hotkeys that work on every chain? Under Speed, turn on Keep money ready on every chain (float). It keeps about $25 on each chain.',
    'To cash out, press Compress: it sells every token and moves everything into one coin — SOL, ETH or BNB — ready to send. Send sends to any address.',
  ],
  careful: [
    'Only the Buy button on a coin’s page, and scripts, top up by themselves. Quick-buy buttons, hotkeys, copy trading and Krypto Trader use only what is already on that chain — the float covers them.',
    'Only SOL, BNB and Robinhood ETH (and USDC on Solana) can pay for a top-up. USDT, USDG, and anything on Ethereum, Base or Arbitrum count in the total but cannot.',
    'A top-up moves at least $25 when it can; what is left stays on that chain for your next buy. Moving money on its own pays Krypt’s 0.5%; money moved for a buy does not — the buy pays its usual 0.5%.',
    'Compress leaves $KRYPTO, coins a running bot holds, and tiny leftovers alone. It does sell coins your copy trading bought.',
    'If you lose the 12 words, nobody can get the wallet back. Not even us.',
  ],
  video: { url: AIO_WALLET_VIDEO_URL, label: 'Watch the All-in-One wallet guide' },
};

/** Standalone deep-dive guides for the higher-stakes features, added
 *  2026-09-23. Each is its own card, like the AI and export guides. */
export const COPY_TRADING_GUIDE: SectionGuide = {
  what: 'Copy trading follows another trader: when they buy a coin, you buy it too, on your own money. It runs by itself once set up. It starts on paper (fake money) on purpose — our own numbers say copying loses money on average, so treat it as a test, not a plan.',
  steps: [
    'Open Automation, then Copy Simple. Paste the wallet address of the trader you want to follow.',
    'Pick how much to spend each time they buy, and which chain.',
    'Press Follow. It starts on paper, so no real money moves.',
    'Watch it for a few days. Copy Trading, beside it, shows what you would have made.',
    'Only if its record convinces you, switch that follow to Live.',
  ],
  careful: [
    'Copying someone copies their losses too. A wallet that did well last week can hand you its next bad week.',
    'You buy after them, at a worse price, and they are often already out by the time you sell.',
    'Keep it on Paper until you have watched it work with fake money. Live spends real SOL on its own.',
  ],
};

export const SCRIPTS_GUIDE: SectionGuide = {
  what: 'A script does something automatically — like "buy any coin the scanner flags over a score of 70, then sell 20 minutes later." Build one with no code, or paste one an AI wrote. Every script runs under a budget you set, and starts on paper.',
  steps: [
    'Open Automation, then Scripts. Press New, and either build a rule or paste a script.',
    'Set the budget first: the most per trade, the most buys per day, and a daily loss limit.',
    'Leave it on Paper. Turn it on and watch what it does for a day or two.',
    'When you trust it, switch it to Live and turn it on. It asks you to confirm.',
  ],
  careful: [
    'A Live script spends real money by itself, even while you sleep. The budget is your safety limit.',
    'The Kill switch turns every script off at once. Use it if anything looks wrong.',
    'Paper tests the rules and the trading only. Public posts like callouts do nothing on paper.',
  ],
};

export const CALLOUTS_GUIDE: SectionGuide = {
  what: 'A callout is a public post on pump.fun saying you are in a coin, under your account’s name. The app can post one automatically on coins you buy or launch, and can also send it to a Discord channel. Every callout ends with a line saying a tool posted it.',
  steps: [
    'Open Automation, then Auto-callout. Write a few lines it can post, one per line.',
    'Turn on "Call out what I buy" and/or "Call out coins I launch."',
    'Optional: paste a Discord webhook to also post each callout to your channel.',
    'Use "Post one now" to see exactly what a callout looks like before switching it on.',
  ],
  careful: [
    'Callouts are public and under your name; pump shows your position in the coin beside them.',
    'You only earn from a callout if it brings real volume — calling every tiny trade just spends your standing.',
    'Nothing posts on paper. A callout is a real, public post whichever mode you are in.',
  ],
};

export const CALLOUT_REWARDS_GUIDE: SectionGuide = {
  what: 'pump.fun pays "callout rewards" in USDC to the wallet of the account that made the call. The app shows what you have been paid and lets you turn that USDC into SOL, or send it to your withdrawal address.',
  steps: [
    'Open Automation, then pump.fun accounts, and find the Callout rewards panel.',
    'Check each account has accepted pump’s reward terms — press Accept terms if not.',
    'When USDC arrives, press Swap to SOL to trade it where it is, or Send to move it to your withdrawal address.',
  ],
  careful: [
    'An account that has not accepted pump’s reward terms may never be paid — do that first.',
    'USDC can only be sent to the withdrawal address you confirmed for that wallet. Nowhere else.',
    'Rewards are pump’s to decide and pay; the app only reads and moves what pump says it paid.',
  ],
};

export const FEES_GUIDE: SectionGuide = {
  what: 'What using the app costs, in plain terms, so nothing is a surprise.',
  steps: [
    'Krypt takes 0.5% of each trade — on the buy, and again on the sell. It is shown before you confirm.',
    'Hold 1,000,000 $KRYPTO in any wallet and that fee is halved, to 0.25% a side.',
    'The Solana network also charges a tiny fee per transaction — that goes to the network, not to us.',
  ],
  careful: [
    'Accounts made or signed in through the app are referred on pump.fun by kryptcc. pump pays Krypt a share of the callout rewards they earn, out of the account’s share. Trading costs nothing extra.',
    'A launch needs a dev buy — your own first buy of the coin — so launching is billed like any buy.',
    'Not financial advice, and nothing here predicts a price. Only trade what you can afford to lose.',
  ],
};

export const SECTION_GUIDES: Record<Exclude<WorkspaceId, 'hub'>, SectionGuide> = {
  terminal: {
    what: 'This is where you look at coins and trade them yourself. Nothing here trades on its own.',
    steps: [
      'Discover shows new coins. Runners shows coins that look strong right now.',
      'Click a coin to open its page. The chart is at the top. The Buy and Sell buttons are on the right.',
      'Before you buy, look at the score and the Security tab. Red things are bad.',
      'Type an amount of SOL and press Buy.',
      'To sell, press Sell. Pick a percent, or 100% to sell all of it.',
      'Orders lets you set a stop loss. That sells for you if the price drops to a number you choose.',
      'Watchlist keeps coins you want to come back to. Wire shows whether the data sources are working.',
    ],
    careful: [
      'A dash (—) means the app does not know something. It is not a zero.',
      'Most new coins go to zero. Never put in more than you can lose.',
      'A buy keeps a little SOL back so you can sell later. That is on purpose.',
    ],
  },
  automation: {
    what: 'Things that trade without you clicking. Copy another trader, or write your own rules.',
    steps: [
      'Copy Simple: paste a trader\'s wallet, pick how much per trade, press Follow on paper. Switch the card to Live only when its record earns it.',
      'Copy Trading: the same follows with every control — sizing, filters, delay, reverse and FOMO. Start on Copy Simple unless you need one.',
      'Reverse does the opposite: it buys when that trader sells, and gets out on its own take-profit, stop-loss or timer. It is a bet, so it starts on paper.',
      'FOMO waits for several wallets to buy the same coin within minutes, then buys too. Our numbers say such crowds usually lose, so it starts on paper.',
      'Scripts: make a rule like "buy if the score is over 70". No code needed. Or paste a script an AI wrote for you.',
      'AI connection: let an AI assistant like Claude read the app, and trade only if you allow it. It starts off. See the AI connection guide.',
      'Everything starts in Paper mode. Watch it for a few days with fake money.',
      'Set the budget first: max per trade, max buys per day, max loss per day.',
      'When you trust it, switch it to Live and turn it on. It will ask you to confirm.',
    ],
    careful: [
      'A Live script spends real money by itself, even while you sleep.',
      'The Kill switch turns every script off at once. Use it if anything looks wrong.',
      'Copying a trader copies their losses too.',
    ],
  },
  engine: {
    what: 'The scanner. It watches every new coin and flags the ones that look good. It never buys anything.',
    steps: [
      'Press Scanning in the top bar to start it.',
      'Dashboard shows what it is seeing. Launches lists every new coin it found.',
      'Execution is where you choose what counts as a runner alert. Stricter means fewer alerts.',
      'Strategy is for research with fake money. It does not touch your wallet.',
      'Console shows the log. Look here if something seems broken.',
    ],
    careful: [
      'A runner alert means "look at this". It does not mean "buy this". Most flagged coins still fail.',
      'The scanner never spends your money.',
    ],
  },
  wallets: {
    what: 'Your wallets, and the tools that move money between them.',
    steps: [
      'All-in-One Wallet is one wallet for every chain, backed up by one phrase. It has its own guide below.',
      'Wallet is your Solana wallet. Robinhood and BNB each have their own page.',
      'On the Robinhood or BNB page, press Check my rewards to see what a reward pool has paid you.',
      'Swap changes one coin into another coin.',
      'Bridge moves coins from one chain to another chain, usually in seconds.',
      'Creator makes extra wallets. Funder sends money to them and collects it back.',
    ],
    careful: [
      'Back up every key you make. Write it down. A lost key is lost money.',
      'Sending coins to the wrong chain or the wrong address loses them. Check twice.',
      'Live execution must be armed on the wallet page before anything real can be sent.',
    ],
  },
  scout: {
    what: 'Shows what other traders did, and what YOU would have made copying them. Useful for finding someone worth following.',
    steps: [
      'Press Record live, or Scan the last hours, so the list fills up.',
      'Pick a time window, like 7 days. Sort by Copy score.',
      'The Copy score is how a copier would have done, not how the trader did. Higher is less bad. A dash means not enough trades yet.',
      'Click a wallet to see why it scored what it did and its recent trades.',
      'Press Follow to copy it. It starts on paper, switched off, so nothing is spent until you arm it.',
    ],
    careful: [
      'Copying loses a little on most wallets, even the best ones. The score picks the least bad, it does not find a winner.',
      'A good day can be luck. Look at many trades over many days, not one big win.',
      'Some top wallets buy and sell within seconds. You cannot copy that fast, and the score marks them.',
    ],
  },
  launch: {
    what: 'Make your own coin on pump.fun. This is off until you turn it on.',
    steps: [
      'Turn it on at the top of the page and read the warning.',
      'Fill in the name, the symbol, a picture, and your links.',
      'You must buy some of your own coin at launch. Choose how much.',
      'Press Launch. It uses its own separate wallet.',
    ],
    careful: [
      'Almost every new coin goes nowhere. Do not expect to make money.',
      'Once a coin is launched it cannot be deleted.',
    ],
  },
  layout: {
    what: 'Your own screen, made of widgets. You choose which ones are on it and where they go.',
    steps: [
      'Press Panels and tick a box, like Chart, Wallet, Links or Games.',
      'Drag a box by its title bar to move it. Pull the corner to resize it.',
      'Open a coin anywhere and the Chart and Links boxes follow it.',
    ],
    careful: ['Nothing on this screen trades by itself. The Wallet box only shows numbers.'],
  },
  system: {
    what: 'Switches, keys, and the rules you agreed to.',
    steps: [
      'Display: language, colours, and a Lite mode if the app feels slow.',
      'Fees: shows what Krypt takes on each trade, and how to pay half.',
      'RPC: paste a Helius key if you want holder data and faster trades. Free ones work, but slower.',
      'Legal: the terms, the privacy page and the risk page. Everything the app sends is listed there.',
    ],
    careful: [
      'Paper or Live is the switch in the top bar, one per chain. Paper means nothing can spend money.',
      'Market data can be turned off. Then charts and prices stop.',
    ],
  },
  guides: {
    what: 'This page. One short guide for each part of the app.',
    steps: ['Click a section on the left to jump to it.', 'The long guides at the bottom explain fees, exits and privacy in detail.'],
    careful: ['If a guide and the app disagree, the app is right and the guide is out of date. Tell us.'],
  },
};

function Bullets({ lines, tone = 'muted' }: { lines: string[]; tone?: 'muted' | 'amber' }) {
  return (
    <ul className="space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="flex gap-2 text-note leading-relaxed text-krypt-muted">
          <span className={cls('mt-[7px] h-1 w-1 flex-shrink-0 rotate-45', tone === 'amber' ? 'bg-amber-300/80' : 'bg-krypt-purple/80')} />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2.5 text-note leading-relaxed text-krypt-muted">
          <span className="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-krypt-purple/40 bg-krypt-purple/15 font-mono text-label text-white">{i + 1}</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

function GuideCard({
  id,
  title,
  guide,
  icon: Icon,
  advanced,
}: {
  id: string;
  title: string;
  guide: SectionGuide;
  icon?: LucideIcon;
  /** Set when the Advanced switch is on: the card shows this instead. */
  advanced?: AdvancedGuide | null;
}) {
  const careful = advanced ? advanced.careful : guide.careful;
  return (
    <Card className="scroll-mt-4 space-y-3">
      <div id={`guide-${id}`} className="flex flex-wrap items-center gap-2">
        {Icon && (
          <span className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-krypt-pink">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <h2 className="font-display text-value font-semibold text-white">{title}</h2>
        {advanced && <span className="rounded border border-krypt-purple/40 bg-krypt-purple/15 px-1.5 py-px text-label uppercase tracking-label text-white/80">Advanced</span>}
        {guide.video && (
          // Through main, never a bare href: the renderer must not navigate.
          <button
            onClick={() => void window.krypt.app.openExternal(guide.video!.url)}
            title="Opens YouTube in your browser"
            className="ml-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-label text-krypt-muted transition hover:border-krypt-purple/50 hover:text-white"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            {guide.video.label}
          </button>
        )}
      </div>
      <p className="text-note leading-relaxed text-white/85">{advanced ? advanced.what : guide.what}</p>
      <div>
        <div className="mb-1 text-label uppercase tracking-label text-krypt-muted">{advanced ? 'Workflow' : 'Do this'}</div>
        <Steps steps={advanced ? advanced.steps : guide.steps} />
      </div>
      {guide.links && guide.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {guide.links.map((l) => (
            <button
              key={l.url}
              onClick={() => void window.krypt.app.openExternal(l.url)}
              title={`Opens ${l.url.replace('https://', '')} in your browser`}
              className="flex items-center gap-1.5 rounded-md border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-1.5 text-body font-semibold text-white transition hover:bg-krypt-purple/20"
            >
              {l.name}
              <ExternalLink className="h-3.5 w-3.5 text-krypt-purple" />
            </button>
          ))}
        </div>
      )}
      {advanced?.details.map((d) => (
        <div key={d.heading}>
          <div className="mb-1 text-label uppercase tracking-label text-krypt-muted">{d.heading}</div>
          <Bullets lines={d.lines} />
        </div>
      ))}
      {careful.length > 0 && (
        <div>
          <div className="mb-1 text-label uppercase tracking-label text-amber-300/90">Careful</div>
          <Bullets lines={careful} tone="amber" />
        </div>
      )}
    </Card>
  );
}

/** Every video in one place, first thing on the page (2026-09-29): one button
 *  per video in a card header was easy to miss. The per-card buttons stay. */
function VideoRow() {
  return (
    <Card className="scroll-mt-4 space-y-3">
      <div id="guide-videos" className="flex items-center gap-2">
        <span className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-krypt-pink">
          <PlayCircle className="h-4 w-4" />
        </span>
        <h2 className="font-display text-value font-semibold text-white">Videos</h2>
        <span className="text-label text-krypt-muted">Open in your browser</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {GUIDE_VIDEOS.map((v) => (
          // Through main, never a bare href: the renderer must not navigate.
          <button
            key={v.url}
            onClick={() => void window.krypt.app.openExternal(v.url)}
            className="flex items-center gap-3 rounded-md border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-2.5 text-left transition hover:bg-krypt-purple/20"
          >
            <PlayCircle className="h-5 w-5 flex-shrink-0 text-krypt-purple" />
            <span className="min-w-0">
              <span className="block text-body font-semibold text-white">{v.title}</span>
              <span className="block text-label leading-relaxed text-krypt-muted">{v.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** The standalone cards after the per-workspace ones, in page order. */
const EXTRA_GUIDES: { id: string; title: string; guide: SectionGuide; icon: LucideIcon }[] = [
  { id: 'aio-wallet', title: 'All-in-One wallet', guide: AIO_WALLET_GUIDE, icon: Layers },
  { id: 'copy-trading', title: 'Copy trading', guide: COPY_TRADING_GUIDE, icon: Users },
  { id: 'scripts-deep', title: 'Scripts', guide: SCRIPTS_GUIDE, icon: Code2 },
  { id: 'pumpfun', title: 'pump.fun accounts', guide: PUMP_GUIDE, icon: AtSign },
  { id: 'callouts', title: 'Callouts', guide: CALLOUTS_GUIDE, icon: Megaphone },
  { id: 'callout-rewards', title: 'Callout rewards', guide: CALLOUT_REWARDS_GUIDE, icon: Coins },
  { id: 'fees', title: 'Fees & referral', guide: FEES_GUIDE, icon: Percent },
  { id: 'ai', title: 'AI connection', guide: AI_CONNECTION_GUIDE, icon: Bot },
  { id: 'pump-export', title: 'Export a pump.fun wallet', guide: PUMP_EXPORT_GUIDE, icon: KeyRound },
];

export function GuidesPage() {
  const sections = WORKSPACES.filter((w) => w.id !== 'guides');
  const [active, setActive] = useState<string>('videos');
  const [advanced, setAdvanced] = useState<boolean>(readAdvanced);
  const listRef = useRef<HTMLDivElement | null>(null);
  const adv = (id: string): AdvancedGuide | null => (advanced ? ADVANCED_GUIDES[id] ?? null : null);

  // The left list follows the scroll, so the reader always knows where they
  // are — no other state, nothing saved.
  useEffect(() => {
    const root = listRef.current?.closest('.overflow-auto') ?? null;
    if (!root) return;
    const onScroll = (): void => {
      const marks = [...document.querySelectorAll<HTMLElement>('[id^="guide-"]')];
      const top = root.getBoundingClientRect().top + 80;
      let current = 'videos';
      for (const m of marks) {
        if (m.getBoundingClientRect().top <= top) current = m.id.replace('guide-', '');
      }
      setActive(current);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, []);

  const jump = (id: string): void => {
    document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };

  const toggle = (): void => {
    const next = !advanced;
    setAdvanced(next);
    writeAdvanced(next);
  };

  const navButton = (id: string, label: string) => (
    <button key={id} onClick={() => jump(id)} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === id ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
      {label}
    </button>
  );

  return (
    <Page
      title="Guides"
      subtitle={
        advanced
          ? 'Advanced: how each part works under the hood — defaults, limits and the settings that change them.'
          : 'How each part of the app works, in plain words. Start at the top if this is your first time.'
      }
      actions={
        <button
          type="button"
          role="switch"
          aria-checked={advanced}
          onClick={toggle}
          title="Swap every guide for its power-user version"
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-body font-semibold text-white/90 transition hover:border-white/20"
        >
          Advanced
          <span className={cls('relative h-5 w-9 rounded-full transition', advanced ? 'bg-krypt-gradient' : 'bg-white/10')}>
            <span className={cls('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition', advanced ? 'left-[18px]' : 'left-0.5')} />
          </span>
        </button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[220px_1fr] items-start">
        <div ref={listRef} className="lg:sticky lg:top-0 space-y-1">
          {navButton('videos', 'Videos')}
          {navButton('start', 'Start here')}
          {navButton('memecoins', 'Memecoin basics')}
          {navButton('api-setup', 'API setup')}
          {sections.map((w) => navButton(w.id, w.title))}
          {EXTRA_GUIDES.map((g) => navButton(g.id, g.title))}
          {navButton('more', 'More detail')}
        </div>

        <div className="space-y-4 max-w-3xl">
          <VideoRow />
          <GuideCard id="start" title="Start here" guide={START_GUIDE} icon={BookOpen} advanced={adv('start')} />
          <GuideCard id="memecoins" title="Memecoin basics" guide={MEMECOIN_GUIDE} icon={Flame} advanced={adv('memecoins')} />
          <GuideCard id="api-setup" title="API setup" guide={API_SETUP_GUIDE} icon={KeyRound} advanced={adv('api-setup')} />
          {sections.map((w) => (
            <GuideCard key={w.id} id={w.id} title={w.title} guide={SECTION_GUIDES[w.id as Exclude<WorkspaceId, 'hub'>]} icon={ICONS[w.id]} advanced={adv(w.id)} />
          ))}
          {EXTRA_GUIDES.map((g) => (
            <GuideCard key={g.id} id={g.id} title={g.title} guide={g.guide} icon={g.icon} advanced={adv(g.id)} />
          ))}
          <div id="guide-more" className="scroll-mt-4">
            <GuidePanel />
          </div>
        </div>
      </div>
    </Page>
  );
}
