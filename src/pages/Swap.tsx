// Swap — its own page in Wallet Utilities.
//
// It started as a card on the Solana wallet page, which was wrong twice over:
// it is not Solana-wallet-specific housekeeping the way arming and backup are,
// and burying a tool people come to the app to USE under a page they open to
// check a balance is the opposite of discoverable. A thing with its own job
// gets its own entry in the menu.
//
// The page is deliberately thin: everything is in `SwapCard`, so the card can
// still be dropped anywhere else (the My Layout panel registry, a future
// token page) without dragging a route with it.

import { Repeat } from 'lucide-react';
import { Page, Section } from '../components/common';
import { SwapCard } from '../components/terminal/SwapCard';

export function Swap() {
  return (
    <Page title="Swap" subtitle="Move what you hold from one token to another, without a buy and a sell.">
      <Section>
        <div className="max-w-xl">
          <SwapCard />
        </div>
      </Section>

      <Section title="What this is">
        <div className="max-w-xl space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-body leading-relaxed text-krypt-muted">
          <p className="flex items-center gap-1.5 font-semibold text-white/80">
            <Repeat className="h-3.5 w-3.5 text-krypt-purple" /> A utility, not a trade
          </p>
          <p>
            A swap opens no position, records no profit or loss, and never touches your strategy. It is the tool for cashing a bag
            out to a stablecoin, consolidating dust, or moving between two tokens without going through SOL and paying twice.
            Anything you want tracked as a trade belongs on the token page instead.
          </p>
          <p>
            Routing is Jupiter's — the same routing every buy and sell in this app already uses, across whatever venue holds the
            liquidity. Every swap is simulated against the live chain before it is signed, and the button that sends it stays
            disabled until that simulation has passed.
          </p>
          <p>
            <span className="text-white/80">All three chains, within themselves.</span> On Solana any token routes to any other.
            On Robinhood Chain and BNB one side has to be that chain&apos;s own coin — their rail builds native-to-token and
            back, and routing one BEP-20 straight into another would need a multi-hop path builder per venue that nobody has
            verified. The page refuses that pair rather than offering a control that fails at the router.
          </p>
          <p>
            <span className="text-white/80">Between chains is a different thing.</span> Moving SOL to BNB is a bridge, not a
            swap: your funds go into a third party&apos;s contract on one chain and come back on another, and for a moment
            somebody else holds them. That is a trust model nothing else in this app asks of you, so it lives on its own page,
            behind its own switch, with its own warning — see <span className="text-white/80">Bridge</span>, and read it there
            first.
          </p>
        </div>
      </Section>
    </Page>
  );
}
