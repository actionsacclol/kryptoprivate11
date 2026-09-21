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
import { BookOpen, Bot, Compass, Cpu, LayoutGrid, Rocket, Settings as SettingsIcon, Users, Wallet, type LucideIcon } from 'lucide-react';
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
          <button onClick={() => jump('more')} className={cls('w-full rounded-md px-3 py-2 text-left text-body font-semibold transition', active === 'more' ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white')}>
            More detail
          </button>
        </div>

        <div className="space-y-4 max-w-3xl">
          <GuideCard id="start" title="Start here" guide={START_GUIDE} icon={BookOpen} />
          {sections.map((w) => (
            <GuideCard key={w.id} id={w.id} title={w.title} guide={SECTION_GUIDES[w.id as Exclude<WorkspaceId, 'hub'>]} icon={ICONS[w.id]} />
          ))}
          <div id="guide-more" className="scroll-mt-4">
            <GuidePanel />
          </div>
        </div>
      </div>
    </Page>
  );
}
