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

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Bot, Code2, Coins, Compass, Cpu, KeyRound, LayoutGrid, Megaphone, Percent, Rocket, Settings as SettingsIcon, Users, Wallet, type LucideIcon } from 'lucide-react';
import { WORKSPACES, type WorkspaceId } from '../workspaces';
import { Card, Page } from '../components/common';
import { GuidePanel } from '../components/GuidePanel';
import { cls } from '../utils/format';

export interface SectionGuide {
  /** One or two short sentences. */
  what: string;
  /** Numbered steps, one action each. */
  steps: string[];
  /** Things that lose money or keys. Short. */
  careful: string[];
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
  what: 'You can let an AI assistant, like Claude, look at this app and — if you choose — trade through it. The way AI assistants plug into apps is called MCP. It can read your wallet, your positions, any coin, the charts, the scanner flags and the wallet records, on all three chains. It talks to this computer only. It starts off, and starts unable to trade.',
  steps: [
    'Open Automation from the Hub. In the menu on the left, press AI connection. Turn the switch on.',
    'Pick how far it reaches. Read only means it can look and nothing else. Paper means it can also trade with fake money. Live means real money.',
    'Press Copy the connect command. That puts one line on your clipboard.',
    'Paste that line into a terminal and press enter. That is it — your AI can now see the app.',
    'Ask it something, like what am I holding, or look up this coin, or what did the scanner flag today.',
    'If you chose Live, set the three limits underneath: the most it can spend on one buy, the most in an hour, and how many trades a minute.',
  ],
  careful: [
    'The line you copy contains a password for your app. Do not paste it into a chat, a screenshot or a video. If it gets out, press New token — the old one stops working straight away.',
    'Live means an AI can buy and sell with your real money on its own. Nobody has shown that an AI trades this app profitably. Start on Paper and read what it did.',
    'It can never take your money out. There is no withdraw, no transfer and no send — the only thing it can do with your funds is trade them, and the coins land back in your own wallet.',
    'It also cannot change any setting, see your key, or hand the app something to sign. It asks; the app decides and builds the trade the same way the buttons do, with the same fee.',
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
    'In Krypto Bot, open Automation, then Wallet list. Paste the key into the Import box and press Import.',
    'Done. That account is now in the app: it can trade and post, and it no longer needs pump.fun sign-in to work.',
  ],
  careful: [
    'pump.fun asks for this key in exactly one place: its own Export Wallet screen. If a DM, an email, or any other site asks for it, it is a scam.',
    'Anyone who has this key controls that wallet and everything in it. Paste it only into Krypto Bot, and never share it or put it in a chat or screenshot.',
    'This is the way to keep using a pump.fun account here after pump changes its web sign-in on 25 September. Importing counts toward your 15 wallets.',
  ],
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
    'Accounts you make through the app are referred on pump.fun by kryptcc. It is disclosed and costs you nothing extra.',
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
      'Watchlist keeps coins you want to come back to. Wire shows news about the coins.',
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
      'Wallet is your Solana wallet. Robinhood and BNB each have their own page.',
      'On the Robinhood or BNB page, press Check my rewards to see what a reward pool has paid you.',
      'Swap changes one coin into another coin.',
      'Bridge moves coins from one chain to another chain. It takes a few minutes.',
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
      'Press Add panel and pick a box, like Chart, Wallet, Links or Games.',
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
      'Live execution is a switch here too. Off means nothing can spend money.',
      'Market data can be turned off. Then charts and prices stop.',
    ],
  },
  guides: {
    what: 'This page. One short guide for each part of the app.',
    steps: ['Click a section on the left to jump to it.', 'The long guides at the bottom explain fees, exits and privacy in detail.'],
    careful: ['If a guide and the app disagree, the app is right and the guide is out of date. Tell us.'],
  },
};

function GuideCard({ id, title, guide, icon: Icon }: { id: string; title: string; guide: SectionGuide; icon?: LucideIcon }) {
  return (
    <Card className="scroll-mt-4 space-y-3" >
      <div id={`guide-${id}`} className="flex items-center gap-2">
        {Icon && (
          <span className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-krypt-pink">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <h2 className="font-display text-value font-semibold text-white">{title}</h2>
      </div>
      <p className="text-note leading-relaxed text-white/85">{guide.what}</p>
      <div>
        <div className="mb-1 text-label uppercase tracking-label text-krypt-muted">Do this</div>
        <ol className="space-y-1.5">
          {guide.steps.map((step, i) => (
            <li key={i} className="flex gap-2.5 text-note leading-relaxed text-krypt-muted">
              <span className="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-krypt-purple/40 bg-krypt-purple/15 font-mono text-label text-white">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
      {guide.careful.length > 0 && (
        <div>
          <div className="mb-1 text-label uppercase tracking-label text-amber-300/90">Careful</div>
          <ul className="space-y-1">
            {guide.careful.map((line, i) => (
              <li key={i} className="flex gap-2 text-note leading-relaxed text-krypt-muted">
                <span className="mt-[7px] h-1 w-1 flex-shrink-0 rotate-45 bg-amber-300/80" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function GuidesPage() {
  const sections = WORKSPACES.filter((w) => w.id !== 'guides');
  const [active, setActive] = useState<string>('start');
  const listRef = useRef<HTMLDivElement | null>(null);

  // The left list follows the scroll, so the reader always knows where they
  // are — no other state, nothing saved.
  useEffect(() => {
    const root = listRef.current?.closest('.overflow-auto') ?? null;
    if (!root) return;
    const onScroll = (): void => {
      const marks = [...document.querySelectorAll<HTMLElement>('[id^="guide-"]')];
      const top = root.getBoundingClientRect().top + 80;
      let current = 'start';
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

  return (
    <Page title="Guides" subtitle="How each part of the app works, in plain words. Start at the top if this is your first time.">
      <div className="grid gap-4 lg:grid-cols-[220px_1fr] items-start">
        <div ref={listRef} className="lg:sticky lg:top-0 space-y-1">
          <button onClick={() => jump('start')} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === 'start' ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
            Start here
          </button>
          {sections.map((w) => (
            <button key={w.id} onClick={() => jump(w.id)} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === w.id ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
              {w.title}
            </button>
          ))}
          {(
            [
              ['copy-trading', 'Copy trading'],
              ['scripts-deep', 'Scripts'],
              ['callouts', 'Callouts'],
              ['callout-rewards', 'Callout rewards'],
              ['fees', 'Fees & referral'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => jump(id)} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === id ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
              {label}
            </button>
          ))}
          <button onClick={() => jump('ai')} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === 'ai' ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
            AI connection
          </button>
          <button onClick={() => jump('pump-export')} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === 'pump-export' ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
            Export a pump.fun wallet
          </button>
          <button onClick={() => jump('more')} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === 'more' ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
            More detail
          </button>
        </div>

        <div className="space-y-4 max-w-3xl">
          <GuideCard id="start" title="Start here" guide={START_GUIDE} icon={BookOpen} />
          {sections.map((w) => (
            <GuideCard key={w.id} id={w.id} title={w.title} guide={SECTION_GUIDES[w.id as Exclude<WorkspaceId, 'hub'>]} icon={ICONS[w.id]} />
          ))}
          <GuideCard id="copy-trading" title="Copy trading" guide={COPY_TRADING_GUIDE} icon={Users} />
          <GuideCard id="scripts-deep" title="Scripts" guide={SCRIPTS_GUIDE} icon={Code2} />
          <GuideCard id="callouts" title="Callouts" guide={CALLOUTS_GUIDE} icon={Megaphone} />
          <GuideCard id="callout-rewards" title="Callout rewards" guide={CALLOUT_REWARDS_GUIDE} icon={Coins} />
          <GuideCard id="fees" title="Fees & referral" guide={FEES_GUIDE} icon={Percent} />
          <GuideCard id="ai" title="AI connection" guide={AI_CONNECTION_GUIDE} icon={Bot} />
          <GuideCard id="pump-export" title="Export a pump.fun wallet" guide={PUMP_EXPORT_GUIDE} icon={KeyRound} />
          <div id="guide-more" className="scroll-mt-4">
            <GuidePanel />
          </div>
        </div>
      </div>
    </Page>
  );
}
