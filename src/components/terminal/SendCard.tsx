// Send — pay any address from the chain's active wallet (2026-10-03).
//
// Phantom-style: who, what, how much, check, send. The card only ASKS: main
// re-reads everything and shows a native confirmation with the exact address
// and amount before anything is signed (ipc.ts send:execute). Withdraw (the
// saved address that profit sweeps use) is a separate card and unchanged.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { Card, GhostButton, PrimaryButton } from '../common';
import { useToast } from '../../state/ToastProvider';
import { EVM_CHAIN_META, explorerTx, type ChainKind } from '@shared/evm';
import type { SendContact, SendHistoryRow } from '@shared/sendBook';
import type { SendRequest, SendResult, SendReview } from '@shared/send';
import { KNOWN_MINTS } from '@shared/swap';
import { cls } from '../../utils/format';

interface Asset {
  /** null = the chain's own coin. */
  token: string | null;
  symbol: string;
  /** Balance in whole units; null = unknown (honest null, shown as —). */
  amount: number | null;
  note: string | null;
}

const chainName = (c: ChainKind): string => (c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name);
const nativeOf = (c: ChainKind): string => (c === 'solana' ? 'SOL' : EVM_CHAIN_META[c].nativeSymbol);
const looksLikeAddress = (c: ChainKind, s: string): boolean =>
  c === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) : /^0x[0-9a-fA-F]{40}$/.test(s);
const fmt = (v: number | null): string =>
  v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 4 : 6 });
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function SendCard({
  chain,
  blocked,
  className,
  bare,
  onSent,
}: {
  chain: ChainKind;
  /** Why sending is unavailable here (shown instead of the form). */
  blocked?: string | null;
  className?: string;
  /** Inside another card: a divider instead of a card of its own. */
  bare?: boolean;
  /** After a send went out — e.g. to refresh a balance shown elsewhere. */
  onSent?: () => void;
}) {
  const toast = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [to, setTo] = useState('');
  const [token, setToken] = useState<string | null>(null);
  // "Other token…": any mint / contract, typed — for tokens the lists above
  // do not carry (a stablecoin someone sent in, say).
  const [other, setOther] = useState(false);
  const [otherToken, setOtherToken] = useState('');
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState(false);
  const [review, setReview] = useState<SendReview | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SendResult | null>(null);
  // The address book: saved names for this chain's address family, and the
  // last few sends on this chain.
  const family = chain === 'solana' ? 'solana' : 'evm';
  const [contacts, setContacts] = useState<SendContact[]>([]);
  const [history, setHistory] = useState<SendHistoryRow[]>([]);
  const [bookFailure, setBookFailure] = useState<string | null>(null);
  const [lastTo, setLastTo] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const loadBook = useCallback(async (): Promise<void> => {
    const r = await window.krypt.wallet.sendBook();
    if (r.ok && r.data) {
      setContacts(r.data.contacts.filter((c) => c.family === family));
      setHistory(r.data.history.filter((h) => h.chain === chain).slice(0, 3));
      setBookFailure(r.data.failure);
    }
  }, [chain, family]);
  useEffect(() => {
    void loadBook();
  }, [loadBook]);
  const sameAddr = (a: string, b: string): boolean => (family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const nameOf = (addr: string): string | null => contacts.find((c) => sameAddr(c.address, addr))?.label ?? null;
  const native = nativeOf(chain);

  const loadAssets = useCallback(async (): Promise<void> => {
    if (chain === 'solana') {
      const [info, held] = await Promise.all([window.krypt.wallet.info(), window.krypt.wallet.holdings()]);
      const list: Asset[] = [{ token: null, symbol: 'SOL', amount: info.ok && info.data ? info.data.balanceSol : null, note: null }];
      for (const h of held.ok && held.data ? held.data : []) {
        if (!(h.uiAmount > 0)) continue;
        const known = KNOWN_MINTS.solana.find((m) => m.mint === h.mint)?.symbol;
        list.push({ token: h.mint, symbol: h.symbol || known || `${h.mint.slice(0, 4)}…`, amount: h.uiAmount, note: null });
      }
      setAssets(list);
    } else {
      const [info, held] = await Promise.all([window.krypt.evm.wallet.info(chain), window.krypt.evm.holdings(chain)]);
      const list: Asset[] = [{ token: null, symbol: native, amount: info.ok && info.data ? info.data.balanceNative : null, note: null }];
      for (const h of held.ok && held.data ? held.data : []) {
        if (!(h.amount > 0)) continue;
        list.push({ token: h.token, symbol: h.symbol || short(h.token), amount: h.amount, note: null });
      }
      setAssets(list);
    }
  }, [chain, native]);

  useEffect(() => {
    void loadAssets();
    setToken(null);
    setReview(null);
    setError(null);
  }, [loadAssets]);

  // Balances move under an open card — a fill, a token found, a refresh, a
  // wallet switch. Re-read them without touching what the person typed: the
  // card used to keep the "—" it read before the first balance landed.
  useEffect(() => {
    const off = window.krypt.engine.onEvent((ev) => {
      if (
        (ev.kind === 'evmFill' && ev.fill.chain === chain) ||
        (ev.kind === 'evmHoldings' && ev.chain === chain) ||
        (ev.kind === 'evmState' && ev.state.chain === chain) ||
        (chain === 'solana' && (ev.kind === 'holdings' || ev.kind === 'walletSwitched'))
      ) {
        void loadAssets();
      }
    });
    const t = window.setInterval(() => {
      if (!document.hidden) void loadAssets();
    }, 20_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [chain, loadAssets]);

  const otherTrim = otherToken.trim();
  const sendToken = other ? (otherTrim || null) : token;
  const otherBad = other && otherTrim !== '' && !looksLikeAddress(chain, otherTrim);
  const asset = other
    ? { token: otherTrim || null, symbol: otherTrim ? short(otherTrim) : 'token', amount: null, note: null }
    : assets.find((a) => a.token === token) ?? { token, symbol: token ? short(token) : native, amount: null, note: null };
  const toTrim = to.trim();
  const addressBad = toTrim !== '' && !looksLikeAddress(chain, toTrim);
  const req = (): SendRequest => ({ chain, to: toTrim, token: sendToken, amount: max ? 'max' : amount.trim() });
  const ready = !blocked && toTrim !== '' && !addressBad && (!other || (otherTrim !== '' && !otherBad)) && (max || amount.trim() !== '');

  // Any edit invalidates the check — a review is for exactly what is typed.
  const edited = (): void => {
    setReview(null);
    setError(null);
  };

  const check = async (): Promise<void> => {
    if (!ready) return;
    setChecking(true);
    setError(null);
    const r = await window.krypt.wallet.sendReview(req());
    setChecking(false);
    if (r.ok && r.data) setReview(r.data);
    else setError(r.message);
  };

  const send = async (): Promise<void> => {
    if (!ready || !review) return;
    setSending(true);
    setError(null);
    const r = await window.krypt.wallet.sendExecute(req());
    setSending(false);
    if (r.data) setLast(r.data);
    if (r.data?.txid) setLastTo(toTrim);
    void loadBook();
    if (r.ok) {
      toast.success(r.message);
      setAmount('');
      setMax(false);
      setReview(null);
      void loadAssets();
      onSent?.();
    } else if (r.message !== 'Send cancelled') {
      setError(r.message);
      setReview(null);
    }
  };

  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-white">Send</div>
        <div className="text-label text-krypt-muted/70">Any address · no Krypt fee · you confirm in a system dialog</div>
      </div>

      {blocked ? (
        <div className="text-body text-amber-300/90">{blocked}</div>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-label text-krypt-muted">To</span>
            {contacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Saved addresses">
                {contacts.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.address}
                    onClick={() => {
                      setTo(c.address);
                      edited();
                    }}
                    className={cls(
                      'rounded-full border px-2.5 py-0.5 text-label',
                      sameAddr(c.address, toTrim) ? 'border-krypt-purple/60 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            <input
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                edited();
              }}
              aria-label="Recipient address"
              placeholder={`Their ${chainName(chain)} wallet address`}
              spellCheck={false}
              className={cls(
                'w-full rounded-lg border bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60',
                addressBad ? 'border-rose-500/50' : 'border-white/10',
              )}
            />
            {addressBad && <span className="text-label text-rose-300/90">That is not a {chainName(chain)} address.</span>}
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <label className="block space-y-1">
              <span className="text-label text-krypt-muted">What</span>
              <select
                aria-label="What to send"
                value={other ? '__other__' : token ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setOther(v === '__other__');
                  setToken(v === '__other__' ? null : v || null);
                  setMax(false);
                  setAmount('');
                  edited();
                }}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
              >
                {assets.map((a) => (
                  <option key={a.token ?? 'native'} value={a.token ?? ''}>
                    {a.symbol} — {fmt(a.amount)}
                  </option>
                ))}
                <option value="__other__">Other token…</option>
              </select>
              {other && (
                <input
                  aria-label="Token address"
                  value={otherToken}
                  onChange={(e) => {
                    setOtherToken(e.target.value);
                    edited();
                  }}
                  placeholder={chain === 'solana' ? 'Token mint address' : 'Token contract (0x…)'}
                  spellCheck={false}
                  className={cls(
                    'mt-1.5 w-full rounded-lg border bg-black/40 px-3 py-2 text-xs font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60',
                    otherBad ? 'border-rose-500/50' : 'border-white/10',
                  )}
                />
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-label text-krypt-muted">Amount</span>
              <div className="flex gap-2">
                <input
                  value={max ? 'Max' : amount}
                  onChange={(e) => {
                    setMax(false);
                    // A comma becomes a dot as it is typed: the field shows
                    // exactly what will be sent (never a hidden 10× amount).
                    setAmount(e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, ''));
                    edited();
                  }}
                  inputMode="decimal"
                  placeholder="0.0"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60"
                />
                <GhostButton
                  onClick={() => {
                    setMax(true);
                    edited();
                  }}
                  className={cls('!py-1.5 !px-3 text-xs', max && '!border-krypt-purple/60')}
                >
                  Max
                </GhostButton>
              </div>
            </label>
          </div>
          <div className="text-label text-krypt-muted/70">
            Balance {fmt(asset.amount)} {asset.symbol}
            {asset.token === null ? ` · Max keeps a little ${native} back for the network fee.` : ''}
          </div>

          {review && (
            <div className="space-y-1.5 rounded-lg border border-krypt-purple/30 bg-krypt-purple/5 px-3 py-2.5 text-body">
              <div className="flex justify-between gap-3">
                <span className="text-krypt-muted">Sends</span>
                <span className="font-semibold text-white">{review.amountText}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-krypt-muted">To</span>
                <span className="break-all text-right font-mono text-white/90">
                  {review.to}
                  {review.contactLabel && <span className="ml-1.5 font-sans text-emerald-300/90">(“{review.contactLabel}”)</span>}
                </span>
              </div>
              {review.networkFeeText && (
                <div className="flex justify-between gap-3">
                  <span className="text-krypt-muted">Network fee</span>
                  <span className="text-white/80">{review.networkFeeText}</span>
                </div>
              )}
              {review.extraCostText && <div className="text-amber-200/90">Also: {review.extraCostText}</div>}
              {review.warnings.map((w) => (
                <div key={w} className="text-amber-300/90">
                  {w}
                </div>
              ))}
            </div>
          )}

          {error && <div className="text-body text-rose-300/90">{error}</div>}

          <div className="flex flex-wrap items-center gap-2">
            {review ? (
              <>
                <PrimaryButton onClick={() => void send()} disabled={sending}>
                  <Send className="h-3.5 w-3.5" /> {sending ? 'Sending…' : `Send ${review.amountText}`}
                </PrimaryButton>
                <GhostButton onClick={() => setReview(null)} disabled={sending} className="!py-2 !px-3 text-xs">
                  Edit
                </GhostButton>
              </>
            ) : (
              <PrimaryButton onClick={() => void check()} disabled={!ready || checking}>
                {checking ? 'Checking…' : 'Review'}
              </PrimaryButton>
            )}
          </div>
        </>
      )}

      {last?.ok && lastTo && !nameOf(lastTo) && !bookFailure && (
        <div className="flex flex-wrap items-center gap-2 text-body text-krypt-muted">
          <span>Save {short(lastTo)} as</span>
          <input
            aria-label="Name for this address"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="e.g. my Ledger"
            maxLength={40}
            className="w-36 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-krypt-purple/60"
          />
          <GhostButton
            onClick={() =>
              void window.krypt.wallet.saveContact(saveName, chain, lastTo).then((r) => {
                if (r.ok) {
                  toast.success(r.message);
                  setSaveName('');
                  void loadBook();
                } else toast.error(r.message);
              })
            }
            disabled={!saveName.trim()}
            className="!py-1 !px-2.5 text-xs"
          >
            Save
          </GhostButton>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-1 text-label text-krypt-muted">
          <div className="uppercase tracking-label text-krypt-muted/60">Recent sends</div>
          {history.map((h) => (
            <div key={`${h.at}-${h.txid ?? ''}`} className="flex flex-wrap items-center gap-2">
              <span className={h.ok ? 'text-white/80' : 'text-rose-300/90'}>{h.amountText}</span>
              <span>to</span>
              <button
                type="button"
                title="Send to this address again"
                onClick={() => {
                  setTo(h.to);
                  edited();
                }}
                className="font-mono hover:text-white"
              >
                {nameOf(h.to) ?? short(h.to)}
              </button>
              {h.txid && (
                <button
                  type="button"
                  onClick={() => void window.krypt.app.openExternal(chain === 'solana' ? `https://solscan.io/tx/${h.txid}` : explorerTx(chain, h.txid!))}
                  className="inline-flex items-center gap-1 text-krypt-purple hover:text-white"
                >
                  <ExternalLink className="h-3 w-3" /> view
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {last && (
        <div className="flex flex-wrap items-center gap-2 text-body text-krypt-muted">
          <span className={last.ok ? 'text-emerald-300/90' : 'text-rose-300/90'}>{last.message}</span>
          {last.txid && <span className="font-mono">{short(last.txid)}</span>}
          {last.explorerUrl && (
            <button
              onClick={() => void window.krypt.app.openExternal(last.explorerUrl!)}
              className="inline-flex items-center gap-1 text-krypt-purple hover:text-white"
            >
              <ExternalLink className="h-3 w-3" /> view
            </button>
          )}
        </div>
      )}
    </>
  );
  // A plain element choice, not a component made per render: a new component
  // type each render would remount the inputs and drop focus on every key.
  return bare ? (
    <div className={cls('space-y-3 pt-3 border-t border-white/10', className)}>{inner}</div>
  ) : (
    <Card className={cls('space-y-3', className)}>{inner}</Card>
  );
}
