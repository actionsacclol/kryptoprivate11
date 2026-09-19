/** @type {import('tailwindcss').Config} */
// Krypto arcane-terminal theme. Token NAMES are kept from the Krypt kit
// so every page keeps compiling; VALUES are re-tuned to the observatory
// palette: obsidian blue-black, parchment text, arcane violet, ritual gold.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Parchment white — every text-white / border-white/10 in the app
        // becomes warm engraved bone on the cold void. Deliberate.
        white: '#F0EDE2',
        'krypt-black': '#030409',
        'krypt-void': '#06070F',
        'krypt-surface': '#12172B',
        'krypt-panel': '#0A0D1A',
        'krypt-muted': '#8C92AB',
        // The ACCENT, and the only part of the palette a theme moves.
        // Channels rather than hex, so `<alpha-value>` keeps every existing
        // `bg-krypt-purple/20` working - 376 uses of krypt-purple alone, and
        // rewriting them would have been the wrong way to add a theme.
        // Values live in src/index.css under :root and html[data-theme].
        'krypt-indigo': 'rgb(var(--krypt-indigo) / <alpha-value>)',
        'krypt-purple': 'rgb(var(--krypt-accent) / <alpha-value>)',
        'krypt-pink': 'rgb(var(--krypt-accent-soft) / <alpha-value>)',
        'arc-gold': '#D9B45B',
        'arc-crimson': '#E5484D',
      },
      fontFamily: {
        sans: ['"Spline Sans"', 'system-ui', 'sans-serif'],
        display: ['Cinzel', 'Georgia', 'serif'],
        pixel: ['Cinzel', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      // ── The type scale ────────────────────────────────────────────
      //
      // Added 2026-09-14. Before it, the app used EIGHT arbitrary pixel
      // sizes across 1,126 class names and TEN letter-spacings, with no
      // names — so "the uppercase label above a number" was written four
      // different ways depending on which page you were on. That reads as
      // carelessness long before anyone can say why.
      //
      // The values are the ones already in use, so naming them changes
      // nothing on screen. What changes is that there is now a right answer
      // to reach for, and `text-[10px]` in a review is a question.
      fontSize: {
        nano: ['8px', { lineHeight: '1.35' }],    // badge text, nothing else
        micro: ['9px', { lineHeight: '1.4' }],    // dense table furniture
        label: ['10px', { lineHeight: '1.45' }],  // THE uppercase micro-label
        body: ['11px', { lineHeight: '1.55' }],   // the workhorse
        note: ['12px', { lineHeight: '1.6' }],    // descriptions, prose
        value: ['13px', { lineHeight: '1.4' }],   // a number you read
        figure: ['15px', { lineHeight: '1.35' }], // a number that is the point
      },
      // Three, down from ten. `label` is the uppercase micro-label, `heading`
      // is a Section's rule-and-title, `display` is a page title.
      letterSpacing: {
        label: '0.14em',    // the uppercase micro-label above a value
        heading: '0.3em',   // a Section's rule-and-title
        display: '0.06em',  // a page title
        eyebrow: '0.34em',  // the gold overline: "The Vault", "WELCOME TO"
        action: '0.1em',    // large uppercase buttons — Buy, Sell
      },
      boxShadow: {
        'krypt-glow': '0 0 22px rgb(var(--krypt-accent) / 0.28)',
        'krypt-card': '0 10px 34px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(240, 237, 226, 0.04)',
        'gold-glow': '0 0 18px rgba(217, 180, 91, 0.3)',
        'crimson-glow': '0 0 18px rgba(229, 72, 77, 0.35)',
      },
      backgroundImage: {
        'krypt-gradient': 'linear-gradient(135deg, rgb(var(--krypt-grad-from)) 0%, rgb(var(--krypt-grad-to)) 100%)',
        'krypt-radial': 'radial-gradient(1100px circle at 50% -14%, rgb(var(--krypt-accent) / 0.13), transparent 62%)',
      },
      animation: {
        'gradient-x': 'gradient-x 8s ease infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.25s ease-out both',
        'pop-in': 'pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
        // fill-mode backwards: no retained transform/filter after the run —
        // a retained value would turn the page wrapper into a containing
        // block and break fixed-position drawers/modals inside it.
        'ink': 'ink 0.12s ease-out backwards',
        'rune-pulse': 'rune-pulse 2.6s ease-in-out infinite',
      },
      keyframes: {
        'gradient-x': { '0%, 100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'pop-in': { from: { opacity: 0, transform: 'scale(0.95)' }, to: { opacity: 1, transform: 'scale(1)' } },
        'ink': { from: { opacity: 0 }, to: { opacity: 1 } },
        'rune-pulse': { '0%, 100%': { opacity: 0.35 }, '50%': { opacity: 1 } },
      },
    },
  },
  plugins: [],
};
