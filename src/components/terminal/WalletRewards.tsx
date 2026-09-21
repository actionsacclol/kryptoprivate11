// "Check my rewards" — on the wallet page of the chain it is about
// (2026-09-20). It used to be the top half of a Rewards page; that page
// became Guides, and the one thing on it worth keeping is this button, which
// belongs beside the wallet whose address it sends.
//
// What it does: asks Merkl what THIS wallet has earned in the reward
// campaigns it is in, on this chain — and, if you ask, lists the campaigns
// running on the chain. It is the surviving half of a killed feature: a
// six-researcher swarm (docs/airdrop-research-2026-09-09.md) found airdrop
// farming does not work, so nothing here predicts, scores or hunts. It
// states what a provider says you have accrued and stops.
//
// THE RULE THAT SHAPES EVERY LINE OF JSX BELOW: no third-party URL is
// rendered, ever, clickable or otherwise. Merkl hands us a `depositUrl` and
// an `explorerAddress` on every row; the provider never maps them, so there
// is nothing here to leak. A claim link is how wallets get drained — fake
// claim sites for these exact protocols exist, and BadgerDAO lost $120.3M to
// an approval injected into its own correct domain. Names are text.
//
// And the second rule: `rows === null` from the provider means we could not
// ask. It renders as an em dash and says why. It never renders as zero.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import type { MerklAnswer, RewardOpportunity, WalletReward } from '../../../electron/data/providers/merkl';
import { Badge, Card, Empty, GhostButton, PrimaryButton, Section } from '../common';
import { dilutedAprPct } from '@shared/rewards';
import { cls, fmtNum, fmtPctOrDash, fmtUsd, shortAddr } from '../../utils/format';

const DASH = '—';

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

/** Default deposit used for the dilution column. Round, obviously an
 *  illustration, and large enough to move a small pool visibly. */
const DEFAULT_ADD_USD = 10_000;

// ── The campaigns running on this chain, on request ──────────────────

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
              <td className="py-2.5 pr-4 text-right tabular-nums text-krypt-muted">{fmtPctOrDash(dilutedAprPct(r.dailyRewardsUsd, r.tvlUsd, addUsd), 2)}</td>
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

  // Opened on request (see WalletRewards), and then it loads once: the list
  // needs no address and says nothing about this install.
  useEffect(() => {
    void run();
  }, [run]);

  const answer = load.state === 'done' ? load.answer : null;
  return (
    <div className="mt-4 border-t border-white/5 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="text-label uppercase tracking-label text-krypt-muted">
          Reward pools on {meta.name}
          {answer?.rows ? ` · ${answer.rows.length} live, read ${ago(answer.at)}` : ''}
        </div>
        <div className="flex items-center gap-3">
          {/* The dilution control: the headline rate is the rate BEFORE you
              arrive; this recomputes it with your money added. */}
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
      </div>
      {load.state !== 'done' ? (
        <div className="flex items-center gap-2 py-6 justify-center text-sm text-krypt-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading Merkl…
        </div>
      ) : answer?.rows === null || answer === null ? (
        // UNKNOWN. Not "no campaigns" — we could not ask.
        <Empty title={DASH} message={`Merkl could not be read, so this is unknown — not zero. ${answer?.message ?? ''}`} action={<GhostButton onClick={() => void run()}>Try again</GhostButton>} />
      ) : answer.rows.length === 0 ? (
        // A real answer: Merkl replied, and there is nothing running.
        <Empty title="No live pools" message={`Merkl lists nothing running on ${meta.name} right now.`} />
      ) : (
        <>
          <CampaignTable rows={answer.rows} addUsd={addUsd} />
          <p className="text-body text-krypt-muted mt-3">
            APR is what the campaign states and it moves as deposits move. “With yours” is the rate after your own money is added, if the reward pot is fixed — the worse of the two possibilities, on purpose. Rewards / day is the whole pot shared by everyone in the pool, not your share.
          </p>
        </>
      )}
    </div>
  );
}

// ── This wallet, on request ───────────────────────────────────────────

/**
 * The wallet page's rewards block for one EVM chain: the button that asks
 * Merkl what this wallet earned (nothing is sent until it is pressed), the
 * answer, and — folded away until asked for — the pools running on the chain.
 */
export function WalletRewards({ chain }: { chain: EvmChainKind }) {
  const meta = EVM_CHAIN_META[chain];
  const [address, setAddress] = useState<string | null>(null);
  const [load, setLoad] = useState<Load<WalletReward>>({ state: 'idle' });
  const [showPools, setShowPools] = useState(false);

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
    <Section title="Rewards" description={`What reward pools on ${meta.name} have paid this wallet, as Merkl reports it. Krypt never claims for you and never shows a claim link.`}>
      <Card>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold tracking-action text-white">Check my rewards</div>
            <p className="text-xs text-krypt-muted mt-1.5 max-w-xl">
              Pressing the button sends this wallet’s address{' '}
              <span className="text-white/80 font-mono">{address ? shortAddr(address, 6) : DASH}</span> to{' '}
              <span className="text-white/80">api.merkl.xyz</span>. Nothing else about this install is sent, and nothing is sent until you press it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => setShowPools((v) => !v)} className="!py-2 !text-xs">
              {showPools ? 'Hide reward pools' : 'Show reward pools'}
            </GhostButton>
            <PrimaryButton onClick={() => void check()} disabled={load.state === 'loading' || !address} className="!py-2 !text-xs">
              {load.state === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {load.state === 'done' ? 'Check again' : 'Check my rewards'}
            </PrimaryButton>
          </div>
        </div>

        {!address && <p className="mt-3 text-xs text-krypt-muted">No EVM wallet on this install yet — create one above first.</p>}

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
                <Badge tone="neutral">answered</Badge> <span className="ml-1">Merkl has no rewards recorded for this address on {meta.name}.</span>
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
                          {r.tokenAddress && <span className="ml-2 font-mono text-body text-krypt-muted">{shortAddr(r.tokenAddress, 5)}</span>}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-white/80">{fmtAmount(r.earned)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-krypt-muted">{fmtAmount(r.claimed)}</td>
                        <td className={cls('py-2.5 pr-4 text-right tabular-nums', r.unclaimed ? 'text-emerald-300' : 'text-white/80')}>{fmtAmount(r.unclaimed)}</td>
                        <td className="py-2.5 text-right tabular-nums text-krypt-muted">{fmtAmount(r.pending)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-body text-krypt-muted mt-3">
                  Earned is everything since the campaign began. Unclaimed is earned minus claimed — what is sitting there. Pending has built up but cannot be collected yet. Read {ago(answer.at)}. To collect, go to the protocol you already use, the way you normally do — this app shows no claim link on purpose.
                </p>
              </div>
            )}
          </div>
        )}

        {showPools && <ChainCampaigns chain={chain} />}
      </Card>
    </Section>
  );
}
