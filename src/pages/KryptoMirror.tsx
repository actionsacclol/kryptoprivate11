import { ArrowUpRight, FlaskConical, KeyRound, Scale, SearchCheck, ShieldAlert, Trophy, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Card, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { KRYPTO_MIRROR_NAME, KRYPTO_MIRROR_URL, KRYPTO_MIRROR_URL_SHORT } from '../kryptoMirror';

// The Copy Trading page, since copy trading left this app (2026-11-04): an
// advert for the standalone app that does it now.
//
// Every line below is something Krypto Mirror's code does, and it stays that
// way: no profit, win-rate, speed or "safe" claim, because that app's own
// research says copying wallets loses on average and its board says so too.
// The fee is on the page because it is a different deal from this app's: the
// $KRYPTO holder waiver does not exist there.

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: Trophy,
    title: 'Ranks what a copier keeps',
    body: 'Wallets are ranked by what a follower would have kept, two seconds behind and after fees, not by what the wallet made. Some weeks it tells you nobody is worth following.',
  },
  {
    icon: SearchCheck,
    title: 'Check a wallet before you follow',
    body: 'Paste a Solana address or a pump.fun username and replay its trades the way a copy would have filled them, side by side with what they made.',
  },
  {
    icon: FlaskConical,
    title: 'Paper first',
    body: 'Every follow starts on paper, charged the delay and the fees a real one pays. Going live takes separate, confirmed steps, and a live follow never comes back armed after a restart.',
  },
  {
    icon: KeyRound,
    title: 'Your key stays on your computer',
    body: 'Keys are encrypted by your operating system and never leave the machine. There is no Krypt account and no server-side wallet.',
  },
  {
    icon: ShieldAlert,
    title: 'Limits on from the start',
    body: 'A daily loss stop, a stop per wallet, a cap on open copies and a pause after failed buys. Every skipped copy is recorded with its reason.',
  },
  {
    icon: Scale,
    title: 'Copy, reverse or just watch',
    body: 'Mirror a wallet, take the other side of it, wait for several wallets to agree, or only get alerts. On Solana, Robinhood Chain and BNB Chain.',
  },
];

export function KryptoMirrorPage({ onOpenPortfolio }: { onOpenPortfolio: () => void }) {
  const download = (): void => void window.krypt.app.openExternal(KRYPTO_MIRROR_URL);

  return (
    <Page title="Copy Trading" subtitle={`Copy trading now has its own app: ${KRYPTO_MIRROR_NAME}.`}>
      <div className="mx-auto max-w-5xl">
        <Card className="mb-6 border-krypt-purple/30 !p-7">
          <div className="flex flex-wrap items-center gap-6">
            <img src="./krypto-mirror.png" alt="" className="h-24 w-24 flex-shrink-0 rounded-2xl" />
            <div className="min-w-[260px] flex-1">
              <h2 className="font-display text-3xl font-semibold tracking-display text-white">{KRYPTO_MIRROR_NAME}</h2>
              <p className="mt-2 max-w-2xl text-value leading-relaxed text-white/80">
                Find wallets worth checking, test a follow on paper, then copy live from a key that stays on your computer. Built only for
                copy trading, by the people who make Krypto Bot.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <PrimaryButton onClick={download} className="!px-6 !py-3 text-base">
              Download {KRYPTO_MIRROR_NAME}
              <ArrowUpRight className="h-4 w-4" />
            </PrimaryButton>
            <span className="text-note text-krypt-muted">
              {KRYPTO_MIRROR_URL_SHORT} · Windows, macOS and Linux · opens in your browser
            </span>
          </div>
        </Card>

        <Section title="What you get">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <Card key={f.title}>
                  <Icon className="h-5 w-5 text-krypt-pink" aria-hidden="true" />
                  <div className="mt-3 text-value font-semibold text-white">{f.title}</div>
                  <p className="mt-1.5 text-note leading-relaxed text-krypt-muted">{f.body}</p>
                </Card>
              );
            })}
          </div>
        </Section>

        <Section title="Before you download">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <div className="text-value font-semibold text-white">What it costs</div>
              <p className="mt-1.5 text-note leading-relaxed text-krypt-muted">
                Free to download. A flat 0.5% on each live buy and sell, and nothing on paper. The $KRYPTO holder waiver in Krypto Bot does not
                apply there.
              </p>
            </Card>
            <Card>
              <div className="text-value font-semibold text-white">What it will not do</div>
              <p className="mt-1.5 text-note leading-relaxed text-krypt-muted">
                Make copying a safe bet. Across 9.3 million trades we measured, copying wallets lost money on average, and no group of wallets was
                profitable to copy after costs. {KRYPTO_MIRROR_NAME} shows you those numbers before you risk anything. You can lose everything. Not
                financial advice.
              </p>
            </Card>
          </div>
        </Section>

        <Card className="border-amber-400/30 bg-amber-400/5">
          <div className="flex flex-wrap items-start gap-4">
            <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-300" aria-hidden="true" />
            <div className="min-w-[260px] flex-1">
              <div className="text-value font-semibold text-white">Were you following wallets here?</div>
              <p className="mt-1.5 text-note leading-relaxed text-krypt-muted">
                Copying has stopped in Krypto Bot. Anything it bought is still in your wallet, and nothing will sell it for you now: mirrored sells
                and a copy&apos;s own exits no longer run. Check your Portfolio and sell by hand what you do not want to keep.{' '}
                {KRYPTO_MIRROR_NAME} keeps its own wallets and settings, so your follows need adding again there.
              </p>
            </div>
            <GhostButton onClick={onOpenPortfolio} className="!py-2 text-xs">
              Open Portfolio
            </GhostButton>
          </div>
        </Card>
      </div>
    </Page>
  );
}
