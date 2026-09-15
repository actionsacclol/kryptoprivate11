// Rewards — what you are actually earning, stated, not guessed.
//
// This page is the surviving half of a killed feature. A six-researcher swarm
// (docs/airdrop-research-2026-09-09.md) found airdrop farming does not work:
// break-even needs a hit rate above 100% once labour is priced, the rules are
// published after the block they measure, and the multi-wallet version is the
// named exclusion on every list that has one. What DOES exist is the opposite
// shape — funded campaigns, publishing a rate, queryable by address, running
// right now. So this page states facts and stops. It has no watchlist, no
// score, no "opportunity you might be missing".
//
// THE RULE THAT SHAPES EVERY LINE OF JSX BELOW: no third-party URL is
// rendered, ever, clickable or otherwise. Merkl hands us a `depositUrl` and an
// `explorerAddress` on every row; the provider never maps them, so there is
// nothing here to leak. Fake claim domains for our own rail already exist (25
// Pons-labelled in ScamSniffer's blacklist, none of them in MetaMask's), and
// checking the domain is not a defence — BadgerDAO lost $120.3M to an approval
// injected into the correct site. Protocol and pool names are text.
//
// And the second rule: `rows === null` from the provider means we could not
// ask. It renders as an em dash and says why. It never renders as zero, and
// never as "no rewards" — those are a different fact.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { EVM_CHAINS, EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import type { MerklAnswer, RewardOpportunity, WalletReward } from '../../electron/data/providers/merkl';
import { Badge, Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { PageGuide, type Guide } from '../components/GuidePanel';
import { dilutedAprPct } from '@shared/rewards';
import { useAppState } from '../state/AppStateProvider';
import { cls, fmtNum, fmtPctOrDash, fmtUsd, shortAddr } from '../utils/format';

const DASH = '—';

/**
 * The page's own guide. Written to answer what someone actually asks while
 * looking at it, in the order they ask it — not a feature tour. The numbers
 * and rules here are the ones the code above uses; if one changes, this
 * changes with it.
 */
const REWARDS_GUIDES: Guide[] = [
  {
    id: 'what',
    title: 'What am I looking at?',
    summary: 'Campaigns that are already funded and already paying',
    body: [
      'A reward campaign is a pot of tokens a protocol has already committed to paying out, over a stated period, to whoever holds or supplies a particular pool. The rate is published in advance and anyone can check it. That is the whole reason this page exists and an "airdrop hunter" does not.',
      'Each row is one campaign: which protocol runs it, which pool it measures, the annualised rate, how much it pays out per day across everyone, and how much is deposited in the pool it measures.',
      [
        'APR is what Merkl states for that campaign. It moves as deposits move.',
        'Daily rewards is the whole campaign, shared by everyone in the pool — not your share.',
        'TVL is what is deposited in the pool. A high daily figure over a high TVL is a small rate.',
      ],
    ],
  },
  {
    id: 'yours',
    title: 'What "Your rewards" means, and what it sends',
    summary: 'Nothing leaves until you press the button',
    body: [
      'The campaign list needs no address, so it loads by itself. Asking what YOUR wallets have earned necessarily tells Merkl which address you are, so the app only asks when you press the button, and says so next to it.',
      [
        'Earned is cumulative since the campaign began, not a balance.',
        'Claimed is the part already collected.',
        'Unclaimed is earned minus claimed — what is sitting there.',
        'Pending has accrued but is not yet written into a distribution, so it cannot be collected yet.',
      ],
      'These figures come from Merkl, not from your own transaction history, so treat them as that provider stating what it believes you are owed.',
    ],
  },
  {
    id: 'dash',
    title: 'Why does it say — instead of a number?',
    summary: 'Unknown and zero are different facts',
    body: [
      'An em dash means the app could not read Merkl, so it does not know. It is never shown for an answer of zero.',
      '"No live campaigns" and an empty rewards list are the opposite: those are real answers meaning there is nothing. The app keeps the two apart deliberately, because a failure that renders as "you have no rewards" is a lie about your money.',
      'If the dash persists, the provider is unreachable or rate-limited. It clears by itself; nothing is wrong with your wallet.',
    ],
  },
  {
    id: 'claim',
    title: 'Why is there no claim button, and how do I actually collect?',
    summary: 'The claim link is how wallets get drained',
    body: [
      'Collect from the protocol you already use — the one whose pool you are in. Reach it the way you normally do, from a bookmark you already trust.',
      'This app deliberately shows no claim link and never claims for you. Fake claim sites for these exact protocols already exist, and checking the address does not save you: BadgerDAO lost $120.3M to a malicious approval served from its own correct domain after an attacker got a Cloudflare key.',
      'The same reasoning is why the names on this page are plain text rather than links. If you ever see this app offer you a claim URL, something is wrong with it.',
    ],
  },
  {
    id: 'chains',
    title: 'Which chains, and why not Solana?',
    summary: 'Robinhood Chain and BNB, when switched on',
    body: [
      'Merkl covers EVM chains. On this app that means Robinhood Chain and BNB Smart Chain, and only the ones you have switched on in Settings — a chain you turned off is never polled here.',
      'Solana has no Merkl coverage, so it is not listed rather than shown empty. That is a gap in the data source, not a statement that Solana has no rewards.',
    ],
  },
  {
    id: 'dilution',
    title: 'What does the "with yours" column mean?',
    summary: 'The headline rate is the rate before you arrive',
    body: [
      'A published APR is the pot divided by what is already deposited. Put your own money in and the same pot is shared more ways, so the rate you actually get is lower than the one advertised. The column recomputes it with the amount you set.',
      'On a large pool it barely moves. On a small one it can halve the rate — which is exactly where the biggest headline numbers come from, and why they are the least trustworthy.',
      'It is a PESSIMISTIC bound. Some campaigns do not work that way: the sponsor pins the rate and simply pays more as deposits arrive, so your arrival does not dilute you. We cannot tell which is which from the data on this page, so the column shows the worse of the two rather than guessing the better one.',
    ],
  },
  {
    id: 'not',
    title: 'What this page will never do',
    summary: 'The short list, so you can hold it to them',
    body: [
      [
        'It will not tell you to deposit anything, or size a position for you.',
        'It will not predict a future token or tell you what you might qualify for.',
        'It will not show a claim link, or claim on your behalf.',
        'It will not show a number it did not read.',
      ],
      'It states published rates and what a provider says you have accrued. Anything beyond that is a decision, and decisions are yours.',
    ],
  },
];


/** Loading and unknown are different states, and neither of them is zero. */
type Load<T> = { state: 'idle' } | { state: 'loading' } | { state: 'done'; answer: MerklAnswer<T> };

function ago(ts: number | null): string {
  if (ts === null) return DASH;
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** Token amount where null is unknown. Rewards run from dust to millions, so
 *  the precision follows the size instead of fixing four decimals on both. */
function fmtAmount(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  if (v === 0) return '0';
  if (v >= 1000) return fmtNum(v, 0);
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(3);
}

function endsIn(ts: number | null): string {
  if (ts === null) return DASH;
  const ms = ts - Date.now();
  if (ms <= 0) return 'ended';
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d`;
  return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
}

// ── Live campaigns, per chain ─────────────────────────────────────────

function CampaignTable({ rows, addUsd }: { rows: RewardOpportunity[]; addUsd: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-label uppercase tracking-label text-krypt-muted">
            <th className="text-left font-semibold py-2 pr-4">Protocol</th>
            <th className="text-left font-semibold py-2 pr-4">Pool</th>
            <th className="text-right font-semibold py-2 pr-4">APR</th>
            <th className="text-right font-semibold py-2 pr-4">
              <span title="What the rate becomes with your money added, if the reward pot is fixed">with yours</span>
            </th>
            <th className="text-right font-semibold py-2 pr-4">Rewards / day</th>
            <th className="text-right font-semibold py-2 pr-4">TVL</th>
            <th className="text-right font-semibold py-2">Ends</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-white/5 align-top">
              <td className="py-2.5 pr-4 whitespace-nowrap">
                <span className="text-white/90">{r.protocol ?? DASH}</span>
                {r.action && <span className="ml-2 text-label uppercase tracking-wider text-krypt-muted">{r.action}</span>}
              </td>
              <td className="py-2.5 pr-4 text-white/80">
                {/* Text. Not a link, by policy — see the header of this file. */}
                <div className="max-w-[26rem]">{r.name}</div>
                {r.tokens.length > 0 && <div className="text-body text-krypt-muted mt-0.5">{r.tokens.join(' · ')}</div>}
              </td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-white/90">{fmtPctOrDash(r.aprPct, 2)}</td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-krypt-muted">
                {fmtPctOrDash(dilutedAprPct(r.dailyRewardsUsd, r.tvlUsd, addUsd), 2)}
              </td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-white/90">{fmtUsd(r.dailyRewardsUsd)}</td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-krypt-muted">{fmtUsd(r.tvlUsd)}</td>
              <td className="py-2.5 text-right tabular-nums text-krypt-muted">{endsIn(r.endsAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Default deposit used for the dilution column. Round, obviously an
 *  illustration, and large enough to move a small pool visibly. */
const DEFAULT_ADD_USD = 10_000;

function ChainCampaigns({ chain }: { chain: EvmChainKind }) {
  const meta = EVM_CHAIN_META[chain];
  const [load, setLoad] = useState<Load<RewardOpportunity>>({ state: 'idle' });
  const [addUsd, setAddUsd] = useState(DEFAULT_ADD_USD);

  const run = useCallback(async () => {
    setLoad({ state: 'loading' });
    const r = await window.krypt.rewards.opportunities(chain);
    // A refused IPC (chain off, unknown chain) is itself an unknown, not a
    // zero — it takes the same branch as a failed fetch.
    setLoad({ state: 'done', answer: r.ok && r.data ? r.data : { rows: null, message: r.message, at: null } });
  }, [chain]);

  // The campaign list needs no address and says nothing about this install,
  // so it may load freely. The wallet lookup below may not.
  useEffect(() => {
    void run();
  }, [run]);

  const answer = load.state === 'done' ? load.answer : null;
  return (
    <Section
      title={`${meta.name} campaigns`}
      description={answer?.rows ? `${answer.rows.length} live, read ${ago(answer.at)}. Sorted by rewards paid per day.` : undefined}
      actions={
        <div className="flex items-center gap-3">
          {/* The dilution control. Every tool in this category shows the
              headline rate, which is the rate BEFORE you arrive. */}
          <label className="flex items-center gap-1.5 text-body text-krypt-muted">
            <span>if I add</span>
            <span className="text-krypt-muted/70">$</span>
            <input
              type="number"
              min={0}
              step={1000}
              value={addUsd}
              onChange={(e) => {
                const n = Number(e.target.value);
                setAddUsd(Number.isFinite(n) && n >= 0 ? n : 0);
              }}
              className="w-24 rounded border border-white/10 bg-black/30 px-2 py-1 text-right font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50"
            />
          </label>
          <GhostButton onClick={() => void run()} disabled={load.state === 'loading'} className="!px-3 !py-1.5 !text-xs">
            {load.state === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </GhostButton>
        </div>
      }
    >
      <Card>
        {load.state !== 'done' ? (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading Merkl…
          </div>
        ) : answer?.rows === null || answer === null ? (
          // UNKNOWN. Not "no campaigns" — we could not ask.
          <Empty
            title={DASH}
            message={`Merkl could not be read, so this is unknown — not zero. ${answer?.message ?? ''}`}
            action={<GhostButton onClick={() => void run()}>Try again</GhostButton>}
          />
        ) : answer.rows.length === 0 ? (
          // A real answer: Merkl replied, and there is nothing running.
          <Empty title="No live campaigns" message={`Merkl lists nothing running on ${meta.name} right now.`} />
        ) : (
          <CampaignTable rows={answer.rows} addUsd={addUsd} />
        )}
      </Card>
    </Section>
  );
}

// ── This wallet, on request ───────────────────────────────────────────

function ChainWalletRewards({ chain }: { chain: EvmChainKind }) {
  const meta = EVM_CHAIN_META[chain];
  const [address, setAddress] = useState<string | null>(null);
  const [load, setLoad] = useState<Load<WalletReward>>({ state: 'idle' });

  // Shown so the disclosure below names the address that would be sent. This
  // reads our own wallet store over IPC; nothing leaves the machine for it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await window.krypt.evm.wallet.info(chain);
      if (live) setAddress(r.ok && r.data ? r.data.address : null);
    })();
    return () => {
      live = false;
    };
  }, [chain]);

  // Deliberately NOT in a useEffect. This is the one call in the feature that
  // discloses anything, and it happens when a person presses the button.
  const check = useCallback(async () => {
    setLoad({ state: 'loading' });
    const r = await window.krypt.rewards.wallet(chain);
    setLoad({ state: 'done', answer: r.ok && r.data ? r.data : { rows: null, message: r.message, at: null } });
  }, [chain]);

  const answer = load.state === 'done' ? load.answer : null;
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold tracking-action text-white">{meta.name}</div>
          <p className="text-xs text-krypt-muted mt-1.5 max-w-xl">
            Checking sends your address{' '}
            <span className="text-white/80 font-mono">{address ? shortAddr(address, 6) : DASH}</span> to{' '}
            <span className="text-white/80">api.merkl.xyz</span>. Nothing else about this install is sent, and nothing is
            sent until you press the button.
          </p>
        </div>
        <PrimaryButton onClick={() => void check()} disabled={load.state === 'loading' || !address} className="!py-2 !text-xs">
          {load.state === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {load.state === 'done' ? 'Check again' : 'Check my rewards'}
        </PrimaryButton>
      </div>

      {!address && (
        <p className="mt-3 text-xs text-krypt-muted">No EVM wallet on this install yet — create one on the wallet page first.</p>
      )}

      {load.state === 'done' && (
        <div className="mt-4 border-t border-white/5 pt-4">
          {answer?.rows === null || answer === null ? (
            <div className="flex items-start gap-2 text-sm">
              <span className="text-2xl leading-none text-krypt-muted">{DASH}</span>
              <div className="text-krypt-muted">
                Unknown — Merkl could not be read, so this is not an answer about your rewards.
                {answer?.message ? <span className="block text-xs mt-1 opacity-80">{answer.message}</span> : null}
              </div>
            </div>
          ) : answer.rows.length === 0 ? (
            <div className="text-sm text-krypt-muted">
              <Badge tone="neutral">answered</Badge>{' '}
              <span className="ml-1">Merkl has no rewards recorded for this address on {meta.name}.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-label uppercase tracking-label text-krypt-muted">
                    <th className="text-left font-semibold py-2 pr-4">Token</th>
                    <th className="text-right font-semibold py-2 pr-4">Earned</th>
                    <th className="text-right font-semibold py-2 pr-4">Claimed</th>
                    <th className="text-right font-semibold py-2 pr-4">Unclaimed</th>
                    <th className="text-right font-semibold py-2">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {answer.rows.map((r) => (
                    <tr key={`${r.chainId}:${r.tokenAddress}:${r.tokenSymbol}`} className="border-t border-white/5">
                      <td className="py-2.5 pr-4">
                        <span className="text-white/90">{r.tokenSymbol}</span>
                        {r.tokenAddress && (
                          <span className="ml-2 font-mono text-body text-krypt-muted">{shortAddr(r.tokenAddress, 5)}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-white/80">{fmtAmount(r.earned)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-krypt-muted">{fmtAmount(r.claimed)}</td>
                      <td className={cls('py-2.5 pr-4 text-right tabular-nums', r.unclaimed ? 'text-emerald-300' : 'text-white/80')}>
                        {fmtAmount(r.unclaimed)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-krypt-muted">{fmtAmount(r.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-body text-krypt-muted mt-3">
                Earned is cumulative since the campaign began; unclaimed is earned minus claimed; pending has accrued but is
                not yet in a distribution root. Read {ago(answer.at)}. Krypt does not claim rewards for you and shows no
                claim link — collect them from the protocol you already use.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── The page ──────────────────────────────────────────────────────────

export function RewardsPage() {
  const { settings } = useAppState();
  // A chain switched off in Settings gets nothing at all — the same rule the
  // wallet pages follow, so a disabled chain is never polled or armed from a
  // surface the user forgot about.
  const chains = EVM_CHAINS.filter((c) => settings.evm[c].enabled);

  return (
    <Page
      title="Rewards"
      subtitle="Published reward rates on the EVM chains you have switched on"
      actions={<Badge tone="neutral">Merkl · api.merkl.xyz</Badge>}
    >
      <Card className="mb-8 border-krypt-purple/25">
        <div className="flex gap-3">
          <ShieldAlert className="h-5 w-5 text-krypt-purple/70 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm text-krypt-muted space-y-2 max-w-3xl">
            <p>
              This page lists reward campaigns that are <span className="text-white/85">already funded and already
              running</span>, and what your own wallet has accrued in them. Every rate here is published by the campaign
              and can be checked before you do anything.
            </p>
            <p>
              It is <span className="text-white/85">not an airdrop hunter</span>. We researched that and it does not work:
              the criteria are set after the fact, and the returns do not cover the effort. Nothing on this page predicts a
              future token, tells you to deposit anything, or links you anywhere — a claim link is how wallets get drained,
              including from sites whose address was correct. Names below are text on purpose.
            </p>
            <p className="text-xs">
              The campaign list is fetched without your address. Checking your own rewards sends your address to Merkl, and
              only happens when you press the button.
            </p>
          </div>
        </div>
      </Card>

      {chains.length === 0 ? (
        <Empty
          title="No EVM chain switched on"
          message="Rewards come from Robinhood Chain and BNB Smart Chain. Turn one on in Settings to see what is running. Solana has no Merkl coverage, so it is not listed here."
        />
      ) : (
        <>
          <Section
            title="Your rewards"
            description="Nothing is sent until you ask. Krypt never claims for you and never shows a claim link."
          >
            <div className="grid gap-4">
              {chains.map((c) => (
                <ChainWalletRewards key={c} chain={c} />
              ))}
            </div>
          </Section>

          {chains.map((c) => (
            <ChainCampaigns key={c} chain={c} />
          ))}
        </>
      )}

      {/* Last, not first: someone who already knows how this works should not
          have to scroll past the explanation to reach the numbers. */}
      <PageGuide
        description="What the numbers mean, what leaves your machine, and how to actually collect."
        guides={REWARDS_GUIDES}
      />
    </Page>
  );
}
