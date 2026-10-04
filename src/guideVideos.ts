// Video guides, opened in the system browser through app.openExternal (main
// only accepts https://). One home so a re-upload is one edit, and so the
// Guides page can show every video in one row (GUIDE_VIDEOS).

/** The Hub's "Tutorial" button (2026-09-14). */
export const APP_TUTORIAL_URL = 'https://www.youtube.com/watch?v=BIvWbqcKgf4';

/** "Watch the guide (10 min)" — the whole app end to end (2026-09-05). Offered
 *  at the end of onboarding and above the long guides. */
export const APP_WALKTHROUGH_URL = 'https://www.youtube.com/watch?v=pqIWxrocy68';

/** krypt cc's general memecoin trading guide (2026-09-29). */
export const MEMECOIN_GUIDE_URL = 'https://www.youtube.com/watch?v=W3vsxuDTey0';

/** "Pumpfun Guide Krypto Bot" — krypt cc's pump.fun quickstart (2026-09-24). */
export const PUMP_QUICKSTART_URL = 'https://www.youtube.com/watch?v=ylEtm666evc';

/** krypt cc's walk-through for the three free API keys — Helius, Birdeye,
 *  Jupiter (2026-09-29). On the onboarding keys step and the API setup guide. */
export const API_KEYS_VIDEO_URL = 'https://www.youtube.com/watch?v=C-q1Vl1YvBY';

/** krypt cc's All-in-One wallet guide (2026-10-03). On the Guides page and
 *  at the top of the All-in-One Wallet page. */
export const AIO_WALLET_VIDEO_URL = 'https://www.youtube.com/watch?v=MJuEgklC-Lo';

/** Where each key is made. The same pages the onboarding "Get a key" links open. */
export const API_KEY_SITES = [
  { name: 'Helius', url: 'https://dashboard.helius.dev' },
  { name: 'Birdeye', url: 'https://bds.birdeye.so' },
  { name: 'Jupiter', url: 'https://portal.jup.ag' },
] as const;

/** Every video, in the order the Guides page shows them. */
export const GUIDE_VIDEOS: readonly { url: string; title: string; blurb: string }[] = [
  { url: APP_TUTORIAL_URL, title: 'App tutorial', blurb: 'Getting around the app.' },
  { url: AIO_WALLET_VIDEO_URL, title: 'All-in-One wallet', blurb: 'One wallet for every chain: buy anywhere, move, compress.' },
  { url: MEMECOIN_GUIDE_URL, title: 'Memecoin trading', blurb: 'How memecoins work, and how not to lose it all.' },
  { url: API_KEYS_VIDEO_URL, title: 'API setup', blurb: 'The three free keys, step by step.' },
  { url: PUMP_QUICKSTART_URL, title: 'pump.fun quickstart', blurb: 'Accounts, sign-in and callouts.' },
  { url: APP_WALKTHROUGH_URL, title: 'Full walkthrough', blurb: 'Every part of the app, about ten minutes.' },
];
