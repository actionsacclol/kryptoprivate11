// The $KRYPTO card on the Hub — see shared/krypto.ts for the rules.
//
// "Buy" opens the token page, not a one-click order: the buy there runs
// through the same Paper/Live gate, arm state, slippage and security panel
// as any other token. A one-tap buy of the maker's own coin on the first
// screen would be the one place this app pressures instead of informs.

import { useEffect, useState } from 'react';
import { Check, Coins, ExternalLink, RefreshCw } from 'lucide-react';
import { KRYPTO_TOKEN, KRYPTO_HOLDER_TOKENS, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive } from '@shared/krypto';
import type { TokenSummary } from '@shared/market';
import { cls } from '../utils/format';
import { refreshKryptoWaiver, useKryptoWaiver } from '../state/useKryptoWaiver';

/** Unknown is an em dash. Never 0. */
const usd = (v: number | null): string => (v === null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const price = (v: number | null): string => (v === null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`);
const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`);
const count = (v: number | null): string => (v === null ? '—' : v.toLocaleString());

export function KryptoCard({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const mint = kryptoTokenLive() ? (KRYPTO_TOKEN.mint as string) : null;
  const [row, setRow] = useState<TokenSummary | null>(null);
  const [failed, setFailed] = useState(false);
  // What this install holds, and whether that halves Krypt's fee. The SAME
  // reading the signer uses, shared with every other screen that names the
  // fee — the card, the Trade panel and Settings must never disagree about
  // whether the next trade is free.
  const held = useKryptoWaiver();
  // The Scan button. Main re-reads the holding every two minutes on its own,
  // so this exists for the moment right after a buy — a holder who has just
  // crossed the line should not pay the fee twice more waiting for a timer.
  // `scanNote` is the button's own outcome and is kept apart from `held`:
  // the reading is main's and shared with every screen, while the fact that
  // YOU pressed Scan and what came of it belongs to this card alone.
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const scan = async (): Promise<void> => {
    if (scanning) return;
    setScanning(true);
    setScanNote(null);
    const why = await refreshKryptoWaiver();
    setScanning(false);
    setScanNote(why ? `Scan failed — ${why}.` : 'Scanned just now.');
  };

  useEffect(() => {
    if (!mint) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await window.krypt.market.summary(mint);
        if (!alive) return;
        if (r.ok && r.data) {
          setRow(r.data);
          setFailed(false);
        } else setFailed(true);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint]);

  if (!mint) return null;

  const stat = (label: string, value: string) => (
    <div className="min-w-[84px]">
      <div className="text-micro uppercase tracking-label text-krypt-muted/60">{label}</div>
      <div className="font-mono text-value text-white/90">{value}</div>
    </div>
  );

  return (
    <section className="mt-10 rounded-xl border border-krypt-purple/30 bg-krypt-panel p-5 shadow-krypt-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="rounded-lg border border-krypt-purple/30 bg-krypt-purple/10 p-2 text-krypt-pink">
            <Coins className="h-5 w-5" />
          </span>
          <div>
            <div className="text-figure font-semibold text-white">
              ${KRYPTO_TOKEN.symbol} <span className="font-normal text-krypt-muted">· {KRYPTO_TOKEN.name}</span>
            </div>
            <div className="text-note text-krypt-muted">Krypt's own token, on pump.fun.</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-5">
          {stat('Price', price(row?.priceUsd ?? null))}
          {stat('Market cap', usd(row?.marketCapUsd ?? null))}
          {stat('Curve', row && row.bondingCurvePct === null && row.marketCapUsd !== null ? 'graduated' : pct(row?.bondingCurvePct ?? null))}
          {stat('Holders', count(row?.holders ?? null))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenToken(mint)}
            className="rounded-lg bg-krypt-gradient px-4 py-2 text-note font-semibold text-white transition hover:opacity-90"
            title="Open the token page — the buy there uses your Paper/Live setting, arm state and slippage like any other token"
          >
            Buy ${KRYPTO_TOKEN.symbol}
          </button>
          <button
            onClick={() => void window.krypt.app.openExternal(kryptoPumpUrl(mint))}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-note text-krypt-muted transition hover:text-white"
            title="Open on pump.fun in your browser"
          >
            <ExternalLink className="h-3.5 w-3.5" /> pump.fun
          </button>
        </div>
      </div>
      {failed && <p className="mt-2 text-body text-amber-300/90">Could not read the market for it right now — the numbers above are the last known, or unknown.</p>}
      <p className="mt-3 text-label leading-relaxed text-krypt-muted/80">{kryptoDisclosure()}</p>

      {/* The holder rate, last and loud.

          It is the one thing on this card that is about the READER rather
          than about the token, so it sits under everything else and is the
          note the eye lands on last. Clicking opens the token PAGE — never a
          one-click order, the same rule the Buy button above follows: this
          app does not turn a banner about its own coin into a trade.

          Both states are yellow. The difference is stated in words and in
          the fill, not in the hue, because "is my fee halved" is a yes/no a
          colour alone should not be carrying.

          It is NOT gated on a completed balance read any more. The offer is a
          fact about the product - hold this much, pay half - and it is true
          before anyone has a wallet. Gating it on `held.at > 0` meant a fresh
          install, or anyone whose read had not landed yet, saw nothing at all
          where the one thing this card is for should be (user report,
          2026-09-18). Only the line about THEIR holding waits for a read.

          The Scan button beside the text asks main to re-read every wallet
          NOW. It is a sibling of the text rather than a child of it because
          the text is itself a button, and a button inside a button is not
          HTML. The line under the title reports a read that FAILED before it
          says "not checked yet": a check that ran and broke is not the same
          as one that never ran, and only the first is something the user
          can act on (it used to say "not checked yet" for both, and did so
          for days while the bridge to main was missing — 2026-09-19). */}
      <div
        className={cls(
          'mt-3 flex items-start gap-3 rounded-lg border px-4 py-3',
          held.halved ? 'border-amber-300/70 bg-amber-400/20' : 'border-amber-300/55 bg-amber-400/[0.12]',
        )}
      >
        <button onClick={() => onOpenToken(mint)} className="min-w-0 flex-1 text-left transition hover:opacity-90" title="Open the coin">
          <span className="flex items-center gap-2">
            {held.halved ? <Check className="h-4 w-4 flex-shrink-0 text-amber-300" /> : <Coins className="h-4 w-4 flex-shrink-0 text-amber-300" />}
            <span className="text-value font-bold text-amber-300">
              {held.halved ? `Half fees on Krypto Bot — active` : `Use Krypto Bot at half the fee`}
            </span>
          </span>
          <span className="mt-1 block text-body font-semibold leading-relaxed text-amber-200">
            Hold {KRYPTO_HOLDER_TOKENS.toLocaleString()} ${KRYPTO_TOKEN.symbol} in any wallet in the app and Krypt&rsquo;s
            0.5% trading fee is halved to 0.25%, on every chain. The referral share halves with it, so whoever sent you here still earns.
          </span>
          <span className="mt-1 block text-label leading-relaxed text-krypt-muted/75">
            {held.problem
              ? `Your holding could not be read, so the fee is charged as usual — ${held.problem}.`
              : held.at === 0
                ? 'Your wallets have not been checked for it yet — press Scan to check them now.'
                : held.halved
                  ? `You hold ${held.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${KRYPTO_TOKEN.symbol}${held.usd !== null ? ` (~$${held.usd.toFixed(2)})` : ''} across ${held.wallets} wallet${held.wallets === 1 ? '' : 's'}.`
                  : `You hold ${held.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${KRYPTO_TOKEN.symbol}${held.usd !== null ? ` (~$${held.usd.toFixed(2)})` : ''} — ${Math.max(0, KRYPTO_HOLDER_TOKENS - held.tokens).toLocaleString(undefined, { maximumFractionDigits: 0 })} more to go.`}
            {scanNote ? ` ${scanNote}` : ''}
            {' '}pump.fun&rsquo;s 1% and the network&rsquo;s own fees are not ours to discount. Tap to open the coin.
          </span>
        </button>
        <button
          onClick={() => void scan()}
          disabled={scanning}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-amber-300/50 bg-amber-400/15 px-3 py-1.5 text-note font-semibold text-amber-200 transition hover:bg-amber-400/25 disabled:cursor-wait disabled:opacity-60"
          title={`Check every wallet in the app for $${KRYPTO_TOKEN.symbol} now. The app also re-checks on its own every two minutes.`}
        >
          <RefreshCw className={cls('h-3.5 w-3.5', scanning && 'animate-spin')} />
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>
    </section>
  );
}
