// "Hold N $KRYPTO and this fee goes away" — the one line, in one place.
//
// It used to exist only on the Solana buy panel, in `text-krypt-muted/45`:
// 45% opacity of a grey that is already muted, on a dark panel. It was there
// and nobody could read it (user report, 2026-09-18). The EVM panel and the
// swap card, which charge the same fee, did not say it at all — so two of the
// three places a user is charged never mentioned the way out.
//
// Bright yellow, and brighter than it first shipped: `arc-gold` (#D9B45B) is
// this app's "your money, pay attention" colour but it is a muted gold, and
// against a dense fee line it still did not catch the eye (user report,
// 2026-09-18). amber-300 is the same idea turned up. Whatever it is, it has
// to match the Hub card's block: one colour for "this removes your fee",
// everywhere it is said.
//
// One component rather than three copies: the last time this line lived in
// several places they disagreed about whether it existed.
//
// Rules it keeps:
//   • It never appears while the fee is already waived — there is nothing to
//     offer someone who has it.
//   • It never appears when no fee is being charged at all.
//   • It never appears while `KRYPTO_TOKEN.mint` is null, so a build shipped
//     before a token exists does not advertise one.
//   • It states the holding and nothing else. No price, no "cheap right now",
//     no buy button: the Hub's card is where buying is offered, with its
//     disclosure attached, and a fee line is not the place to sell a coin.

import { KRYPTO_FEE_WAIVER_TOKENS, kryptoTokenLive } from '@shared/krypto';
import { cls } from '../../utils/format';
import { useLocale } from '../../state/useLocale';

export function WaiverHint({
  waived,
  charged = true,
  className,
}: {
  /** From `useKryptoWaiver()` — the same answer the signer uses. */
  waived: boolean;
  /** False when this surface is charging nothing anyway (fees off, an
   *  unpriceable pair), so the app never offers to remove a fee it is not
   *  taking. */
  charged?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  if (waived || !charged || !kryptoTokenLive()) return null;
  return (
    <span className={cls('font-semibold text-amber-300', className)}>
      {/* Translated, unlike the rest of the fee copy: this is an OFFER, not a
          statement about what happened to someone's money. The amount is
          interpolated so no catalogue can rewrite the number. */}
      {t('waiver.hold', { amount: KRYPTO_FEE_WAIVER_TOKENS.toLocaleString() })}
    </span>
  );
}
