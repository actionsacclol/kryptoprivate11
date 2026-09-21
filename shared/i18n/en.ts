// The English catalogue — and, because it is typed `as const`, the definition
// of what a message key IS. Every other locale is a Partial of this, so a key
// that does not exist here cannot be translated, and a key that exists here
// and is missing from a translation falls back to this text.
//
// That fallback is the honest-null rule in another costume: an untranslated
// string shows the English, never a blank and never a raw key. A trader who
// sees "settings.execution.title" has been told nothing; one who sees
// "Execution" has been told the truth in the wrong language, which is
// recoverable.
//
// SCOPE, decided deliberately (2026-09-18):
//
//   TRANSLATED — navigation, buttons, settings labels, onboarding. The chrome
//   you need to find your way around and to set the app up.
//
//   NOT TRANSLATED — the legal documents (shared/legal/), and any message that
//   states what happened to someone's money: fills, refusals, fee lines,
//   breaker reasons. A mistranslated privacy policy is a liability, and a
//   mistranslated "the fee was charged because your holding could not be read"
//   is worse than the same sentence in a language you half-read. The English
//   there is authoritative and says so.
//
// Keys are `area.thing`. Interpolation is `{name}` and is done by `t()`.

export const en = {
  // ── language picker ────────────────────────────────────────────────
  'lang.title': 'Language',
  'lang.hint': 'Menus, buttons and settings. Legal documents and anything describing your money stay in English, which is the version that governs.',
  'lang.system': 'Match my system',

  // ── navigation ─────────────────────────────────────────────────────
  'nav.discover': 'Discover',
  'nav.token': 'Token',
  'nav.watchlist': 'Watchlist',
  'nav.runners': 'Runners',
  'nav.wire': 'Wire',
  'nav.trades': 'Trades',
  'nav.orders': 'Orders',
  'nav.portfolio': 'Portfolio',
  'nav.solWallet': 'Sol Wallet',
  'nav.robinhoodWallet': 'Robinhood Wallet',
  'nav.bnbWallet': 'BNB Wallet',
  'nav.swap': 'Swap',
  'nav.bridge': 'Bridge',
  'nav.observatory': 'Observatory',
  'nav.copyTrading': 'Copy Trading',
  'nav.scripts': 'Scripts',
  'nav.groupWallets': 'Group Wallets',
  'nav.funder': 'Funder',
  'nav.launches': 'Launches',
  'nav.execution': 'Execution',
  'nav.backtest': 'Backtest',
  'nav.history': 'History',
  'nav.guides': 'Guides',
  'nav.walletScout': 'Wallet Scout',
  'nav.launchToken': 'Launch a token',
  'nav.widgets': 'Widgets',
  'nav.settings': 'Settings',
  'nav.about': 'About',
  'nav.legal': 'Legal',

  // ── common actions ─────────────────────────────────────────────────
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.delete': 'Delete',
  'action.refresh': 'Refresh',
  'action.back': 'Back',
  'action.next': 'Next',
  'action.done': 'Done',
  'action.copy': 'Copy',
  'action.search': 'Search',
  'action.continue': 'Continue',

  // ── common words ───────────────────────────────────────────────────
  'common.on': 'On',
  'common.off': 'Off',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.unknown': 'Unknown',
  'common.loading': 'Loading…',
  'common.paper': 'Paper',
  'common.live': 'Live',
  'common.wallet': 'Wallet',
  'common.chain': 'Chain',

  // ── settings sections ──────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.rpc': 'RPC endpoints',
  'settings.execution': 'Execution',
  'settings.strategy': 'Strategy',
  'settings.data': 'Market data',
  'settings.alerts': 'Alerts',
  'settings.hotkeys': 'Hotkeys',
  'settings.bots': 'Telegram & Discord',
  'settings.ai': 'AI analysis',
  'settings.display': 'Display',
  'settings.privacy': 'Privacy',
  'settings.fees': 'Fees',

  // ── top bar ────────────────────────────────────────────────────────
  'mode.paper': 'Paper',
  'mode.live': 'Live',
  'mode.switchTitle': 'Paper / Live — each chain is armed on its own',
  'wallet.balance': 'Balance',
  'wallet.noWallet': 'No wallet',
  'wallet.copyAddress': 'Copy address',

  // ── engine status (bottom of the sidebar) ──────────────────────────
  'status.scanning': 'Scanning',
  'status.attuning': 'Attuning',
  'status.dormant': 'Dormant',

  // ── settings sections ──────────────────────────────────────────────
  'settings.general': 'General',
  'settings.solanaRpc': 'Solana RPC',
  'settings.marketData': 'Market data',
  'settings.chatBots': 'Chat bots',
  'settings.aiAnalysis': 'AI analysis',
  'settings.dataCollection': 'Data collection',
  'settings.creatorBlocklist': 'Creator blocklist',
  'settings.feesAndReferral': 'Fees and referral',
  'settings.subtitle': 'Market data providers, RPC endpoints, recorder, presence.',

  // ── appearance + replay ────────────────────────────────────────────
  'settings.theme': 'Theme',
  'settings.themeHint': 'Pick a look — fonts, surfaces, corners, effects — then an accent colour. Green for up, red for down and gold for anything about your money stay where they are.',
  'settings.replay': 'Replay the walkthrough',
  'settings.replayHint': 'Shows the first-run screens again. Nothing is reset — your wallets, keys and settings are untouched.',
  'onboarding.appearance': 'Language and colour',

  // ── onboarding ─────────────────────────────────────────────────────
  'onboarding.welcome': 'Welcome to Krypt',
  'onboarding.language': 'Pick your language',
  'onboarding.languageHint': 'You can change this any time under Settings.',
  'onboarding.discover': 'Discover',
  'onboarding.checkBeforeYouBuy': 'Check before you buy',
  'onboarding.tradeManually': 'Trade manually',
  'onboarding.everythingUnderSettings': 'Everything is under Settings',
  'onboarding.getStarted': 'Get started',

  // ── the one money line that IS translated ──────────────────────────
  // Not a statement about what happened to anyone's funds — an offer, and one
  // people should be able to read. The amount is interpolated, never rewritten.
  'waiver.hold': 'Hold {amount} $KRYPTO to halve this fee',
} as const;

export type MessageKey = keyof typeof en;

/** A translation. Partial on purpose: what is missing falls back to English. */
export type Catalogue = Partial<Record<MessageKey, string>>;
