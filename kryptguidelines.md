# KRYPT GUIDELINES — The One File for Building Krypt Software

> **This is the single source of truth.** It merges `guidelines.md` (brand),
> `READMEGUIDE.md` (engineering), `security.md` + `lightprotection.txt`
> (protection), `discordguide.md` (RPC), and the shipped **Krypt Macro**
> codebase (the reference implementation) into one document.
>
> **Audience: an AI building or extending a Krypt tool.** Read this top-to-bottom
> once, then keep it open. If you do everything here, the new tool will look,
> feel, and behave like every other Krypt tool — which is the whole point.
>
> **Mission of the suite:** ship *free, open-source, no-ads, no-telemetry,
> no-bloat* Windows utilities that are genuinely good, look identical, and
> quietly advertise Krypt through Discord Rich Presence every time they run.

---

## 0. How to use this file (AI read-me-first)

When you build a new Krypt tool, the rule hierarchy is:

1. **Krypt Macro is the reference implementation.** When this doc and an old
   guideline disagree, do what Krypt Macro's shipped code does. The biggest
   reconciled decisions (old docs are *superseded*):
   - **Font = Chakra Petch** for UI (not Inter). JetBrains Mono for code/numbers,
     Press Start 2P for tiny accents only.
   - **Accent gradient = indigo→purple→pink** `#6366F1 → #A855F7 → #EC4899`
     (not `#8B5CF6→#6366F1`).
   - **Cards = `rounded-2xl`**, buttons/inputs `rounded-xl`, small controls
     `rounded-lg`, pills/badges `rounded-full`.
2. **Copy the design system in §3 verbatim.** Same tokens, same components, same
   shell. This is what makes everything look the same. Do not reinvent it.
3. **Default tech stack is Electron + React + TypeScript + Vite + Tailwind**
   (§4). Only deviate with a stated reason.
4. **Every tool ships the non-negotiables in §13** (Discord RPC, krypt.cc links,
   MIT, dark Krypt look, no silent failures).

The fast path: **scaffold from Krypt Macro**, swap the tool-specific pages, keep
the shell/tokens/components/build/RPC identical.

---

## 1. Brand in one line + voice

**Krypt is the dark, neon-lit identity layer for gamers and creators** — a
toolkit of free PC utilities tied to a Discord-first ecosystem.

- **Tagline:** *Your digital identity.*
- **Rotating short taglines:** "Forge your identity." · "Not just another
  link-in-bio." · "Free tools. Real identity. No bloat."
- **Voice:** confident, slightly gritty, never corporate. Talk like a gamer, not
  a marketer. Short sentences. **No emojis in official copy** (Discord chat is
  the only exception). Product copy is blunt and honest — e.g. Krypt Macro's
  subtitle is literally *"Free. No ads. No telemetry. No bullshit."*

---

## 2. Brand identity

### 2.1 Logo

The mark is a **stylized white "K" with glowing eyes and sharp wing-like
flares** — half arcane sigil, half esports mark. Ships as `krypt.png` (and a
multi-size `krypt.ico` for Windows).

**Rules:**
- The mark stays **white** (`#FFFFFF`). Never recolor, outline, gradient-fill,
  flip, stretch, or skew it. Scale uniformly.
- On dark UI, always pair it with a purple glow:
  `drop-shadow(0 0 6px rgba(168,85,247,0.55))`
  (Tailwind: `drop-shadow-[0_0_6px_rgba(168,85,247,0.55)]`).
- Place on pure black `#000000` or deep void `#0A0A0F`. Never on busy photos
  without a solid plate.
- Minimum size 16px (favicon) / 24px (web UI). Clear space ≥ the height of the
  logo's "eyes."
- As an `<img>`, always guard with an `onError` that hides it (see §3.5) so a
  missing asset never breaks layout.

### 2.2 Color system — the canonical tokens

Krypt is **dark-first**. The **80/20 rule:** ≥80% of any surface is black /
near-black; the gradient is a finishing accent, never a wallpaper. Never use two
competing gradients in one view. Never use raw red/green as brand color — they
are reserved for state.

| Token | Hex | Tailwind token | Use |
|---|---|---|---|
| `krypt-black` | `#000000` | `bg-krypt-black` | Marketing canvas, deepest wells |
| `krypt-void` | `#0A0A0F` | `bg-krypt-void` | **App background / chrome** |
| `krypt-surface` | `#141419` | `bg-krypt-surface` | Raised surfaces |
| `krypt-panel` | `#11111A` | `bg-krypt-panel` | **Cards / panels** |
| `krypt-muted` | `#A1A1AA` | `text-krypt-muted` | Secondary text |
| white | `#FFFFFF` | `text-white` | Primary text + the logo |
| `krypt-indigo` | `#6366F1` | — | Gradient stop 1 |
| `krypt-purple` | `#A855F7` | `krypt-purple` | Gradient stop 2 / accent / glow |
| `krypt-pink` | `#EC4899` | — | Gradient stop 3 |

**The Krypt gradient (the one defining accent):**
```css
linear-gradient(90deg, #6366F1 0%, #A855F7 50%, #EC4899 100%);
```
Tailwind token `bg-krypt-gradient`. Used on: primary buttons, the active-nav
rail, "on" switches, progress bars, the wordmark, hover scrollbar.

**Borders / hairlines:** `border-white/10` (default), `border-white/20` on hover.

**Semantic state colors (Tailwind families — use these, not the brand gradient,
for status):**

| State | Color | Usage |
|---|---|---|
| Success / Playing | `emerald` (`#22C55E`) | success toasts, "playing" glow |
| Warning | `amber` (`#F59E0B`) | warn toasts, caution banners |
| Destructive / Recording | `rose` (`#EF4444`) | errors, delete, "recording" glow |
| Info / accent | `indigo` / `krypt-purple` | info, neutral-active |

### 2.3 Typography

| Role | Font | Tailwind | Weights | Use |
|---|---|---|---|---|
| UI / body | **Chakra Petch** | `font-sans` | 300–700 | Everything. Wide, technical, "cyber/esports" feel. |
| Code / numbers | **JetBrains Mono** | `font-mono` | 400–600 | Hotkeys (`<kbd>`), counters, coords, % readouts |
| Tiny accent | **Press Start 2P** | `font-pixel` | 400 | Retro chrome details, easter eggs. **Never body copy.** |

Load all three from Google Fonts (§3.4). Body uses
`font-feature-settings: 'cv11','ss01','ss03'`.

Scale guidance: page title `text-3xl font-bold tracking-tight`; section eyebrow
`text-xs font-semibold uppercase tracking-[0.18em] text-krypt-muted`; body
`text-sm`; secondary `text-xs text-krypt-muted`.

The wordmark **"Krypt"** always uses the gradient via `.text-krypt-gradient`;
the rest of a product name is plain white (e.g. <span>Krypt</span> Macro).

### 2.4 Core UI motifs (what makes a screen "feel Krypt")

1. **Void canvas** `bg-krypt-void` + one **radial purple bloom** pooling top-left:
   `bg-krypt-radial` = `radial-gradient(700px circle at 18% 0%, rgba(168,85,247,0.18), transparent 60%)`, rendered as a `pointer-events-none fixed inset-0` layer.
2. **Hairline borders** `border border-white/10`, brightening to `/20` on hover.
3. **Soft glass cards** — `rounded-2xl border border-white/10 bg-krypt-panel/80 backdrop-blur-sm` + `shadow-krypt-card`.
4. **Purple glow bloom** on accent / hover: `shadow-krypt-glow` = `0 0 24px rgba(168,85,247,0.35)`.
5. **Rounded everything** — capsule pills (`rounded-full`), 2xl cards, xl buttons.
6. **Gradient accents in motion** — `animate-gradient-x` on hero gradients; the
   active nav item gets a gradient rail.
7. **Logo always glows** — `drop-shadow-[0_0_6px_rgba(168,85,247,0.55)]`.
8. **State = color + soft glow** — recording pulses rose (`glow-recording`),
   playing pulses emerald (`glow-playing`).
9. **Motion is slow & confident** — 150–250ms transitions, `animate-fade-in` /
   `animate-pop-in`. Never bouncy or jittery.

---

## 3. The Krypt UI kit — COPY THIS (the "look the same" core)

> This section is the heart of the doc. Drop these files in unchanged and the new
> tool inherits the Krypt look for free. All snippets are taken from shipped
> Krypt Macro.

### 3.1 `tailwind.config.js` (drop-in, canonical tokens)

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'krypt-black': '#000000',
        'krypt-void': '#0A0A0F',
        'krypt-surface': '#141419',
        'krypt-panel': '#11111A',
        'krypt-muted': '#A1A1AA',
        'krypt-indigo': '#6366F1',
        'krypt-purple': '#A855F7',
        'krypt-pink': '#EC4899',
      },
      fontFamily: {
        sans: ['"Chakra Petch"', 'Inter', 'system-ui', 'sans-serif'],
        pixel: ['"Press Start 2P"', 'monospace'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'krypt-glow': '0 0 24px rgba(168, 85, 247, 0.35)',
        'krypt-card': '0 8px 30px rgba(0, 0, 0, 0.45)',
      },
      backgroundImage: {
        'krypt-gradient': 'linear-gradient(90deg, #6366F1 0%, #A855F7 50%, #EC4899 100%)',
        'krypt-radial': 'radial-gradient(700px circle at 18% 0%, rgba(168,85,247,0.18), transparent 60%)',
      },
      animation: {
        'gradient-x': 'gradient-x 8s ease infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.25s ease-out both',
        'pop-in': 'pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
      },
      keyframes: {
        'gradient-x': { '0%, 100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'pop-in': { from: { opacity: 0, transform: 'scale(0.95)' }, to: { opacity: 1, transform: 'scale(1)' } },
      },
    },
  },
  plugins: [],
};
```

### 3.2 `src/index.css` (drop-in base + utilities)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html, body, #root {
    height: 100%;
    background-color: #0A0A0F;
    color: white;
    font-family: 'Chakra Petch', Inter, system-ui, -apple-system, sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
  }
  ::selection { background-color: rgba(168, 85, 247, 0.32); color: white; }
  * { box-sizing: border-box; }
  /* Krypt scrollbar — thin, dark, gradient-on-hover. */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.08); border-radius: 8px; }
  ::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #6366F1 0%, #A855F7 50%, #EC4899 100%); }
}

@layer utilities {
  .text-krypt-gradient {
    background-image: linear-gradient(90deg, #6366F1 0%, #A855F7 50%, #EC4899 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .text-krypt-shimmer {
    background-image: linear-gradient(90deg, #FFFFFF 0%, #DDD6FE 50%, #FFFFFF 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .glow-purple    { box-shadow: 0 0 24px rgba(168, 85, 247, 0.35); }
  .glow-recording { box-shadow: 0 0 16px rgba(239, 68, 68, 0.55); }
  .glow-playing   { box-shadow: 0 0 16px rgba(34, 197, 94, 0.5); }
  .scanlines {
    background-image: repeating-linear-gradient(to bottom,
      rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px);
  }
}
```

### 3.3 `index.html` font loading

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Press+Start+2P&display=swap"
  rel="stylesheet"
/>
<!-- body class: bg-krypt-void text-white antialiased -->
```

### 3.4 App shell — sidebar + topbar + radial bloom

Every Krypt desktop tool uses the same three-part shell: a fixed **220px left
Sidebar** (logo + nav + status/footer), a **TopBar** (primary actions + global
toggles), and a scrollable **`<main>`** of pages. The whole thing sits on
`bg-krypt-void` with the radial bloom behind it.

```tsx
// App shell skeleton (from Krypt Macro App.tsx)
<div className="flex h-full bg-krypt-void">
  <div className="pointer-events-none fixed inset-0 bg-krypt-radial" />
  <Sidebar current={route} onNavigate={setRoute} /* status flags */ />
  <div className="flex flex-col flex-1 min-w-0 relative">
    <TopBar /* primary actions + console/overlay toggles */ />
    <main className="flex-1 min-h-0">{/* active page */}</main>
  </div>
</div>
```

**Sidebar anatomy** (`w-[220px] border-r border-white/5 bg-krypt-void/80 backdrop-blur-md`):
- **Brand block:** glowing `krypt.png` + gradient "Krypt" wordmark over an
  uppercase tracked tool name (`text-[11px] uppercase tracking-[0.2em]`).
- **Nav:** `lucide-react` icons + label; active item = `bg-white/10 text-white border border-white/10`
  with a gradient rail `absolute left-0 ... w-0.5 bg-krypt-gradient` and the icon
  tinted `text-krypt-purple`; inactive = `text-krypt-muted hover:bg-white/5`.
- **Footer:** a live status dot (rose=recording / emerald=playing / muted=idle,
  `animate-pulse-slow` when active), a 2-up grid of **krypt.cc** (Globe) +
  **Discord** buttons, and `Free & open source · no ads, no telemetry`.

```tsx
// Active nav item pattern
<button className={cls(
  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition relative',
  active ? 'bg-white/10 text-white border border-white/10'
         : 'text-krypt-muted hover:text-white hover:bg-white/5 border border-transparent',
)}>
  <Icon className={cls('h-4 w-4', active && 'text-krypt-purple')} />
  {label}
  {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full bg-krypt-gradient" />}
</button>
```

**TopBar anatomy** (`px-6 py-3 border-b border-white/5 bg-krypt-void/60 backdrop-blur-md`):
left cluster = the tool's primary verbs (e.g. Record / Play / Stop) as bordered
pills that switch to state-colored glows when active and carry a `<kbd>` hotkey
hint; right cluster = global toggles (Overlay, Console) + a progress bar
(`h-1.5 bg-krypt-gradient`) and a mono `%` readout while busy.

### 3.5 The logo, used safely

```tsx
<img
  src="./krypt.png" alt=""
  className="h-9 w-9 rounded-md drop-shadow-[0_0_6px_rgba(168,85,247,0.55)]"
  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
/>
```

### 3.6 Component library (`src/components/common.tsx`)

Build these once and reuse them on every page. Canonical class strings:

| Component | Canonical classes |
|---|---|
| **Page** | header `px-8 pt-7 pb-5`, title `text-3xl font-bold tracking-tight`, body `flex-1 overflow-auto px-8 pb-8` |
| **Section** | `mb-8`; eyebrow `text-xs font-semibold uppercase tracking-[0.18em] text-krypt-muted` |
| **Card** | `rounded-2xl border border-white/10 bg-krypt-panel/80 backdrop-blur-sm shadow-krypt-card p-5`; `hoverable` adds `hover:border-white/20 hover:shadow-krypt-glow` |
| **PrimaryButton** | `rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-krypt-glow bg-krypt-gradient hover:brightness-110 active:scale-[0.98]` |
| **GhostButton** | `rounded-xl border border-white/10 bg-white/5 text-white/90 hover:bg-white/10 hover:border-white/20`; `destructive` → rose variant |
| **IconButton** | `h-9 w-9 rounded-lg border`; active → `border-krypt-purple/50 bg-krypt-purple/15 shadow-krypt-glow` |
| **Switch** | track `h-6 w-11 rounded-full`; on → `bg-krypt-gradient shadow-[0_0_10px_rgba(168,85,247,0.5)]`, off → `bg-white/10` |
| **NumberInput** | `rounded-lg border border-white/10 bg-black/40`; **string buffer, clamp on blur only** (see note) |
| **Empty** | `rounded-2xl border border-dashed border-white/10 bg-black/20 py-16 text-center` |
| **Badge** | `rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider`; tones neutral/success/warn/danger/gradient |
| **`<kbd>`** | `rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-mono text-krypt-muted border border-white/10` |

**`cls()` helper** (in `src/utils/format.ts`) is the standard conditional-class
join used everywhere: `cls('base', cond && 'extra', className)`.

> **NumberInput gotcha (ship this exact behavior):** never bind a numeric input
> straight to the number and clamp every keystroke — deleting all digits snaps to
> `min` and the user can't type a fresh value. Keep a **string buffer while
> focused**, emit the parsed number live, and clamp to `[min,max]` only on
> blur/Enter. Re-sync from the prop only when not focused.

### 3.7 Toasts, modals, and "never fail silently"

- **`useToast()`** exposes `success / warn / error / info`. **Every backend call
  ends in a toast** on both success and failure — no silent anything. Map backend
  log levels: `error→toast.error`, `warn→console.warn`, plus a `player.onToast`
  stream for in-app messages.
- **Build an in-app `<Modal>` + `usePrompt()/useConfirm()` in week one.** Electron
  disables `window.prompt/confirm/alert` (they silently no-op). Implement a single
  `<ModalProvider>` at the root holding a queue; each hook pushes and returns a
  `Promise`.
- Standard provider nesting: `<ToastProvider><ModalProvider><AppStateProvider>`.

---

## 4. Tech stack & architecture

### 4.1 Default stack (deviate only with a reason)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** (latest stable) | Native Windows APIs (registry, services, UAC, input hooks) + HTML UI iteration speed |
| Renderer | **React 18 + TypeScript** | Typed IPC boundaries, ecosystem |
| Bundler | **Vite + `vite-plugin-electron`** | Fast HMR, auto-respawn on main edits |
| Styling | **Tailwind** | The token system in §3 |
| Icons | **`lucide-react`** | One line-icon family. **Never mix icon families.** |
| Drag/sort | **`@dnd-kit/*`** | Reorder lists / editors |
| Installer | **`electron-builder` + NSIS** | Widest Windows compat |
| Discord | **`discord-rpc`** | Best-effort presence, never blocks startup |
| Native FFI | **`koffi`** | Win32 calls (user32/gdi32/winmm) with **no C++ compile at install** |
| Input hook | **`uiohook-napi`** | Global mouse/keyboard, prebuilt binaries |

**Hard rule (project-wide):** **no local C++ toolchain compile at `npm install`.**
Prefer pure-JS / WASM / koffi-FFI. Before adding any dependency, try shelling out
to a built-in Windows tool (`reg`, `sc`, `powershell`, `powercfg`, `wmic`) —
native tools never go stale.

> **WASM-in-Electron trap (learned the hard way):** some WASM modules **freeze the
> Electron main process** on init (OpenCV-WASM did; it was dropped for a pure-JS
> matcher). Others are fine because they self-manage their own worker
> (`tesseract.js` does). **Rule: run heavy/unknown WASM in a `worker_thread`, and
> verify by actually launching the app — the freeze only shows at runtime, not in
> typecheck/build.**

### 4.2 Project structure (canonical)

```
KryptTool/
├── build/            # electron-builder assets (installer.nsh)
├── resources/        # krypt.png, krypt.ico, bundled data
├── scripts/          # make-ico, dev helpers
├── shared/           # types.ts (+ pure logic) shared by main + renderer
├── electron/
│   ├── main.ts       # bootstrap, single-instance lock, windows, tray
│   ├── preload.ts    # contextBridge → window.krypt.*
│   ├── ipc.ts        # ALL ipcMain.handle() in ONE file (greppable contract)
│   └── system/       # the ONLY place that touches the OS (thin wrappers)
├── src/              # renderer (React)
│   ├── components/   # common.tsx (UI kit), Sidebar, TopBar, Console
│   ├── pages/        # one file per sidebar route
│   ├── state/        # ToastProvider, ModalProvider, AppStateProvider
│   ├── utils/format.ts  # cls(), fmtMs(), summaries
│   └── index.css, main.tsx, App.tsx
├── tsconfig.json     # renderer + shared (no project references!)
├── tsconfig.node.json# electron + shared
└── vite.config.ts
```

### 4.3 Layering rules (enforce strictly)

1. **`electron/system/**` is the only code that touches the OS.** Everything else
   composes these typed wrappers; nothing spawns processes directly.
2. **`src/**` never imports from `electron/**`.** The only seam is `window.krypt.*`
   exposed by `preload.ts` and typed in `shared/types.ts` + a `global.d.ts`.
3. **All IPC channels live in exactly one file** (`electron/ipc.ts`).
4. **Wrappers return `{ ok, message, data? }`, never throw across IPC.** A thrown
   error gets swallowed and the UI shows "success" for a no-op. Catch inside,
   return the result, toast it.
5. **Keep tsconfig project *references* out of Vite projects** — they cause
   `TS6305/6306/6310` during `electron-builder`. Keep renderer and node tsconfigs
   decoupled.

### 4.4 IPC & contextBridge

```ts
// preload.ts — expose specific functions only, never raw ipcRenderer
contextBridge.exposeInMainWorld('krypt', {
  app:    { version: () => ipcRenderer.invoke('app:version'),
            openExternal: (u) => ipcRenderer.invoke('app:openExternal', u) },
  /* ...namespaced groups... */
  log:    { onAppend: (cb) => { /* ipcRenderer.on + return cleanup */ } },
});
```

- Every method typed in `shared/types.ts` and re-declared in a `global.d.ts`
  `window.krypt` block — TypeScript catches channel-name drift before runtime.
- **Event subscriptions must return a cleanup function.** Forgetting it leaks
  listeners across HMR ("5 toasts on every click").

---

## 5. Windows system interaction — the gotchas that cost days

1. **Never spawn a bare exe name.** Packaged Electron launches with a stripped
   PATH. Resolve absolute paths via a `systemBin()` helper:
   `%SystemRoot%\System32\<exe>` for everything **except** `powershell.exe`
   (which lives in `System32\WindowsPowerShell\v1.0\`) and `pwsh.exe`
   (`Program Files\PowerShell\7\`).
2. **Run system tools silently** — single `run(cmd,args,opts)` helper with
   `windowsHide: true` + a hard timeout; return `{ ok, code, stdout, stderr }`.
   Never flash a `cmd` window.
3. **Coerce PowerShell objects to strings** with `.ToString()` before JSON, or
   you get `@{Name=...; Status=Running}` garbage.
4. **Registry/system ops return typed results, not exceptions.** Translate
   cryptic `reg.exe` stderr into user strings ("Access denied — needs
   Administrator").
5. **Restore/undo must be idempotent** — treat "not found" / already-in-desired-
   state as success, or the first thing the user sees is a wall of red toasts.
6. **UAC elevation in packaged builds:** pass a sentinel argv flag
   (`--krypt-elevate-relaunch`); the elevated child retries
   `requestSingleInstanceLock()` on a 200ms interval for up to 10s; the old
   instance's `second-instance` handler `app.quit()`s when it sees the flag.
   **Auto-elevation does NOT work in dev under `vite-plugin-electron`** — ship a
   `run-as-admin.bat` and be honest about the two-step manual process.
7. **Admin-gated UX:** check `isAdmin()` on mount; show a yellow "Not running as
   Administrator" banner + relaunch button; block admin-required actions with a
   toast rather than failing silently. **Prefer `HKCU` over `HKLM`** so changes
   don't need elevation at all.
8. **User data goes in `app.getPath('userData')`** (`%APPDATA%\<AppName>`), never
   `Documents`/`Desktop` — Windows **Controlled Folder Access** silently blocks
   those and profiles vanish with unseen `EPERM`.
9. **Write config atomically** (`settings.json.tmp` → `fs.renameSync`) and always
   `mergeState(loaded)` over `DEFAULT_STATE` on load **and** on preset apply —
   never trust persisted JSON even when you wrote it (old saves lack new fields).

---

## 6. Overlay & input-driven apps (HUDs, crosshairs, macro overlays)

Only relevant if the tool is a transparent always-on-top overlay, listens to
global input, or runs multiple coordinated windows. Consumer overlays should
**never** ask for admin.

- **Baseline overlay window:** `frame:false, transparent:true, focusable:false,
  skipTaskbar:true, hasShadow:false, alwaysOnTop:true, backgroundColor:'#00000000'`
  (eight zeros — anything else tints dark games), `type:'toolbar'` on win32 (keeps
  it out of Alt-Tab). Then `setAlwaysOnTop(true,'screen-saver')`,
  `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`,
  `setIgnoreMouseEvents(true,{forward:false})` for click-through.
- **Re-assert those flags on every `showInactive()`** — Windows drops them on
  hide/show. Use `showInactive()`/`hide()`, never `show()` (steals focus →
  alt-tab stutter).
- **`setContentProtection(true)`** hides the overlay from OBS/recorders — make it
  a setting (good for streamer mode, bad for demos).
- **Exclusive-fullscreen games can't be overlaid** (compositor limit). Document
  it; tell users to use Borderless / Fullscreen-Windowed.
- **Global input** via `uiohook-napi`, wrapped in a **ref-counted singleton** so
  independent consumers don't fight over `start()/stop()`. Build config: add to
  Vite `rollupOptions.external` **and** electron-builder `asarUnpack`, or the
  packaged app crashes with `Cannot find module`.
- **Native hooks via koffi** for Win32 that uiohook can't do (raw-input deltas,
  `GetCursorInfo`, `SendInput` relative moves, `timeBeginPeriod(1)` for 1ms
  timers). **TSFN-safety rule:** never unsubscribe/stop a native hook
  synchronously inside its own callback — defer with `setImmediate` + a guard.
- **Frameless drag:** use `-webkit-app-region: drag` (with `focusable:true` +
  `showInactive()` on Windows), `no-drag` on interactive children. Never roll
  your own JS drag — it breaks across hide/show cycles.
- **Multi-window state:** broadcast to `BrowserWindow.getAllWindows()`, never a
  hardcoded recipient list. For hotkey-triggered UI, **queue the payload in main,
  drain on renderer mount** so a cold-start window doesn't miss the event.
- **"Unplaced" sentinel:** use `(x === -1 && y === -1)`, never `x < 0` — secondary
  monitors live at negative coordinates on Windows.

---

## 7. Build & packaging

### 7.1 `package.json` essentials

```json
{
  "name": "krypt-<tool>",
  "productName": "Krypt <Tool>",
  "version": "1.0.0",
  "author": { "name": "Krypt", "email": "hi@krypt.cc", "url": "https://krypt.cc" },
  "homepage": "https://krypt.cc/tools/<tool>",
  "license": "MIT",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit",
    "dist": "npm run build && electron-builder",
    "make-ico": "node scripts/make-ico.mjs"
  },
  "build": {
    "appId": "cc.krypt.<tool>",
    "productName": "Krypt <Tool>",
    "files": ["dist/**", "dist-electron/**", "resources/**"],
    "asarUnpack": ["**/node_modules/uiohook-napi/**", "**/node_modules/koffi/**"],
    "directories": { "buildResources": "build", "output": "release" },
    "win": { "target": ["nsis"], "icon": "resources/krypt.ico",
             "artifactName": "${productName}-Setup-${version}.${ext}" },
    "nsis": {
      "oneClick": false, "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": false, "createStartMenuShortcut": true,
      "installerIcon": "resources/krypt.ico", "uninstallerIcon": "resources/krypt.ico",
      "uninstallDisplayName": "Krypt <Tool>", "include": "build/installer.nsh",
      "shortcutName": "Krypt <Tool>"
    },
    "publish": null
  }
}
```

### 7.2 Icons — always a multi-size `.ico`

The taskbar/NSIS need an **`.ico` with 7 sizes** (16/24/32/48/64/128/256). A
single PNG looks hideous small. Pad the source PNG to a **square ≥256×256**
(512×512 ideal) first, then convert with `scripts/make-ico`. **Never** point
`win.icon`/`installerIcon` at a `.png` → `invalid icon file`.

### 7.3 NSIS finish page (desktop shortcut opt-in)

`build/installer.nsh` — offer a "Create desktop shortcut" checkbox via
`customFinishPage`. **Gotchas:** use `${APP_FILENAME}.exe` (not
`${APP_EXECUTABLE_FILENAME}`); the shortcut function must be referenced *inside*
the `customFinishPage` macro; and **wrap any top-level `Function` in
`!ifndef BUILD_UNINSTALLER … !endif`** — otherwise it lands in the uninstaller
pass too, triggering NSIS warning 6010 which electron-builder treats as fatal.

### 7.4 npm warnings — mostly ignore

Deprecation/audit warnings from `electron-builder`/`node-gyp` are dev-only
transitive deps that never ship. **Do** care about vulns in renderer deps
(`npm audit --omit=dev`) and in `electron` itself (stay on latest stable).
**Don't** run `npm audit fix --force` — it wrecks the lockfile.

### 7.5 Pre-commit / pre-release gates

Run **`npm run typecheck && npm run build`** before every commit (catches
main-process errors HMR hides), and **`npm test`** if the tool has logic tests.
Then `npm run dist` and test the **installer end-to-end**, not just the dev
build.

---

## 8. Discord Rich Presence — the marketing engine

> When a user runs any Krypt tool, their Discord shows `Using Krypt <Tool>` with
> the Krypt logo. **This is the entire marketing engine.** Every tool must
> register and show RPC. The tool has to be good enough that people keep it
> installed.

**Implementation rules (`electron/system/discord.ts`):**
- Use `discord-rpc`, **best-effort, never block startup**. Wrap login in
  try/catch — Discord may not be running; that's fine, not an error.
- **Never throw out of the RPC module.** All `setActivity` calls `.catch()`.
- Large image key = `krypt` (the asset uploaded in the Dev Portal → Rich
  Presence → Art Assets; it's an asset *name*, not a URL). Large image text =
  `Krypt <Tool>`.
- Update `details`/`state` live with app state ("Recording macro",
  "Playing — loop 5/100").
- **Always `stopDiscordRpc()` on quit / `window-all-closed`** or the socket leaks
  and the next launch can't connect.

**Canonical buttons (max 2, must be `https://`):**
```ts
buttons: [
  { label: 'Free Tools', url: 'https://krypt.cc/tools' },
  { label: 'Krypt.cc',   url: 'https://discord.gg/muzFKR657F' },
]
```

**Shared Discord app identity** (from `discordguide.md` — reuse across tools):
- Application / Client ID: `1495323918234423406`
- Public key: `6968d9764b10a779148c113ad7fc014adf74d12a0600972f1224c9c814b5d3de`
- The app **name** above the activity is the Discord application's display name
  (rename it in the portal per tool), **not** anything in code.
- Invite / community: `https://discord.gg/muzFKR657F` (vanity) — the single
  canonical invite. Use it everywhere: Sidebar footer, About links and RPC
  buttons. (The old `7GQgwkfBmG` invite is dead — do not use it.)

---

## 9. Lightweight protection — anti-rebrand / anti-strip (the default for free JS/Electron tools)

> Goal: make the software **annoying to copy, annoying to rebrand, annoying to
> strip the Krypt branding / RPC out of** — *without* hurting performance, UX, or
> maintainability. This is **friction, not war.** It is free software.
> Apply this to every shipped tool. (For native C++ tools, see §10.)

**Rules:** keep it lightweight; don't break functionality; no pointless
obfuscation; protect **only** high-value parts (branding, Discord RPC, identity
strings, update/config loading); everything stays maintainable; **a debug flag
disables all protections.**

**The seven techniques (targeted, not app-wide):**

1. **String protection (the main thing).** Never store branding/RPC strings as
   clean literals: app name, Discord client ID, RPC activity text, official +
   update URLs. Encode them (XOR / base64+shuffle / char-code arrays / split
   fragments like `"Kr"+"ypt"`) and **reconstruct at runtime.** Result: no clean
   string search → no quick rebrand.
2. **Distributed branding.** Spread branding across UI, RPC, logs, and internal
   identifiers so removing it means touching many places — not deleting one file.
3. **Discord RPC hardening.** Don't isolate RPC in one obvious file. Split setup
   across config + runtime + helpers; obfuscate app ID + presence text; add a
   light integrity check so removing/patching RPC triggers **degraded fallback**,
   not an obvious crash.
4. **Soft integrity checks.** Hash a few key modules (main entry, RPC, app
   identity, preload). On mismatch **don't crash** — quietly enter **degraded
   mode** (RPC off, theme/customization off, update check off, about/support
   links gone, app name becomes generic). Never show "tamper detected."
5. **Feature coupling (important).** Tie RPC/branding into normal startup: app
   boot loads identity data → that same data feeds RPC **and** window title, tray
   tooltip, settings hydration, updater, about page. Careless branding removal →
   settings fail to hydrate, updates disable, UI falls back to limited mode. Make
   a rebrander *understand the system* instead of deleting a file. **Never break
   the app's main function unless tampering is blatant.**
6. **Watermarking (stealth).** Embed project identity in harmless constants, dead
   branches that survive minification, UI/math constants, config schema version —
   a unique number derived from the app name used in a harmless calc. Lets you
   *prove* a stolen/rebranded build came from your code later.
7. **Build-level protection.** Production builds: minify, mangle names, remove
   source maps, strip console logs, tree-shake, bundle into fewer files with
   non-obvious chunk names. Electron: bundle main/preload/renderer, **ship no raw
   TypeScript/source**, use ASAR (unpack only native modules/assets), disable
   devtools in prod.

**Naming friction:** rename identity/RPC functions to boring generic names —
`syncRuntimeState`, `resolveSessionMeta`, `hydrateClientContext` — **not**
`initDiscordRPC`, `brandConfig`, `kryptPresence`. Avoid obvious filenames like
`rpc.js` / `branding.js`.

**Hard limits — do NOT add:** aggressive anti-debugging, kernel tricks, forced
exits, destructive behavior, heavy encryption everywhere, anything malware-like.

**Output discipline when implementing:** modify only relevant parts, keep code
clean and maintainable, ensure everything still runs perfectly, and make sure the
debug flag fully disables protections for development.

---

## 10. Native (C++) IP hardening — advanced appendix

Only if a tool ships a native C++ binary with real IP to protect (licensing,
proprietary algorithms). This is heavier than §9 and **out of scope for a normal
free Electron tool.** The full playbook lives in `security.md`; the shape:

- **Absolute rules:** every protection compatible with the codebase; no
  regressions; comment each change `// [PROTECTION] ...`; a `DEBUG_MODE` /
  `SECURITY_DEBUG_BYPASS` flag disables all of it; state each technique's perf
  impact (LOW/MODERATE/HIGH); no placeholder code.
- **Phase 1 — analyze:** map build env + critical modules + sensitive plaintext +
  symbol exposure; classify modules CRITICAL/HIGH/MODERATE/LOW; rank attack
  vectors.
- **Layer 1 (static):** compile-time string obfuscation (constexpr XOR/AES), IAT
  hardening (hash-resolved `GetProcAddress`), symbol stripping + LTO + path
  scrubbing, anti-disassembly on CRITICAL functions only.
- **Layer 2 (dynamic):** multi-layer debugger detection, hooking/integrity
  scans — but respond with **deferred, stealthy graduated degradation** (subtly
  corrupt state after a random delay so the analyst thinks it's *buggy*, not
  protected), **never** an immediate crash or "tamper" message.
- **Layer 3 (architectural):** control-flow flattening, MBA obfuscation, optional
  VM/commercial packer (VMProtect/Themida) for the few CRITICAL functions; build
  watermarking; hardened compiler/linker flags (`/GS /guard:cf /DYNAMICBASE
  /HIGHENTROPYVA`, `-fstack-protector-strong -fPIE -D_FORTIFY_SOURCE=3`, etc.).
- New code under `include/security/` + `src/security/`, namespaced
  `security::anti_debug` etc., compiling warning-free (`-Wall -Wextra` / `/W4`).
- Finish with the self-verification checklist + the final delivery summary table
  from `security.md`.

---

## 11. Safety & ethics (non-negotiable)

1. **No silent failures, ever.** Every failed action reaches the user via a toast
   with an actionable message.
2. **Reversible by default.** Any tweak/clean/delete that changes the system needs
   a working revert, or it goes in an *Advanced* area behind a red risk badge.
   Confirm destructive actions with a one-line plain-English explanation. Krypt
   tools never silently modify the system.
3. **Label risk honestly.** `safe`/`balanced`/`risky` must be truthful — `safe`
   on a tweak that nukes Windows Update is dishonest.
4. **Back up before batch operations** (System Restore Point / one-click backup).
5. **No ads, no telemetry, no bundled adware.** Any opt-in telemetry is opt-in and
   off by default. Ship as a single signed `.exe`.
6. **Dual-use tools get a responsible-use notice** and stay honest about limits
   (e.g. "humanization ≠ defeating real anti-bot detection"). Don't inject DLLs,
   read game memory, or touch anti-cheat surfaces for consumer tools.
7. **Support the platforms you claim.** Detect Win10 vs Win11 and skip
   incompatible features instead of running them blind.

---

## 12. Naming & repo conventions

| Thing | Convention | Example |
|---|---|---|
| Product name | `Krypt <Tool>` (space, title case) | `Krypt Macro` |
| Never | `KryptMacro`, `K-Macro`, `krypt_macro` | — |
| Executable / npm name | kebab-case | `krypt-macro` |
| App ID | `cc.krypt.<tool>` | `cc.krypt.macro` |
| GitHub repo | `github.com/krypt-net/krypt-<tool>` | MIT license |
| Landing page | `krypt.cc/tools/<tool>` | `krypt.cc/tools/macro` |
| Discord app name | `Krypt <Tool>` (set in portal) | `Krypt Macro` |

Handles (in order of availability): `@krypt`, `@kryptcc`, `@kryptdotcc`,
`@kryptnet`. Never underscores or numbers. Bio template:
`Your digital identity. / Custom bio pages + free PC tools. / krypt.cc · discord.gg/muzFKR657F`.

---

## 13. Universal "is it Krypt?" checklist

Before a tool counts as a Krypt tool, verify **all** of:

- [ ] Dark `bg-krypt-void` background dominates; one radial purple bloom; 80/20 rule holds.
- [ ] Uses the §3 tokens/components verbatim (Chakra Petch, the gradient, 2xl cards, hairline borders, glows).
- [ ] Krypt logo is white + unmodified with the purple `drop-shadow` glow; only the wordmark "Krypt" uses the gradient; no second competing gradient.
- [ ] Sidebar + TopBar shell matches the reference; footer shows krypt.cc + Discord + "Free & open source · no ads, no telemetry."
- [ ] **Discord RPC registered** and shows `Using Krypt <Tool>` with the logo + 2 https buttons; best-effort, stopped on quit.
- [ ] `krypt.cc` is visible (sidebar/footer/About) and the About page cross-promotes the rest of the suite.
- [ ] No silent failures — every backend call toasts; in-app `<Modal>`/`usePrompt` exist (no `window.prompt`).
- [ ] All OS access behind typed `electron/system/*` wrappers that return `{ok,message}`; IPC in one file; `src` never imports `electron`.
- [ ] User data in `app.getPath('userData')`; config written atomically + merged over defaults on load.
- [ ] Single signed `.exe`, MIT, open-source on `krypt-net`, no ads/telemetry/bloat.
- [ ] Lightweight §9 protection applied to branding + RPC; debug flag disables it.
- [ ] No emojis in official marketing copy; honest, blunt voice.

---

## 14. Ship checklists

### 14.1 Every tool
- [ ] `npm run typecheck` — zero errors
- [ ] `npm run build` — zero errors
- [ ] `npm test` — green (if the tool has logic)
- [ ] `npm run dist` — produces an installer; **test the installer end-to-end**
- [ ] Desktop-shortcut opt-in appears & works; icon sharp in Start menu / taskbar / Add-Remove
- [ ] Every sidebar page loads; primary actions toast on success **and** failure
- [ ] Discord RPC activity appears within ~10s, both buttons visible, correct app name
- [ ] Close & relaunch — single-instance lock works, no zombie processes
- [ ] Uninstall — no stray shortcuts; `%APPDATA%\<AppName>` cleaned or intentionally preserved (documented)

### 14.2 System / privileged tools (Tweaker-class) — add
- [ ] First launch in user mode shows the admin banner; relaunch-as-admin elevates cleanly (old window closes, elevated reappears ~1s)
- [ ] Apply + revert one tweak per category; backup → external change → restore reports no false failures
- [ ] Win10 **and** Win11 paths exercised; incompatible tweaks skipped, not run blind

### 14.3 Overlay / input tools (Crosshair / Macro-class) — add
- [ ] Overlay is click-through over test games; absent from Alt-Tab; re-asserts always-on-top after focus loss
- [ ] Global hotkeys fire from inside games; rebinding captures modifiers; mouse-button binds blocked with a hint
- [ ] Frameless windows drag on primary **and** negative-coord secondary monitors; positions restored after relaunch
- [ ] With Vanguard/EAC/BattlEye running, hold→fire→release returns to center within ~1s (anti-cheat drops `mouseup`)
- [ ] Native modules in `asarUnpack` + Vite `external`; document any game unsupported in exclusive fullscreen

---

## 15. The one-paragraph summary

Scaffold from Krypt Macro. Keep the §3 design system **exactly** — Chakra Petch,
the indigo→purple→pink gradient, `bg-krypt-void` + radial bloom, 2xl glass cards,
hairline borders, purple glows, the sidebar+topbar shell, and the `common.tsx`
component kit. Build on Electron+React+TS+Vite+Tailwind with **no C++ compile at
install** (koffi/WASM/shell-outs), put all OS access behind typed
`electron/system/*` wrappers that return `{ok,message}` and never throw, register
the channels in one `ipc.ts`, and never let `src` import `electron`. Store data in
`userData`, write atomically, merge over defaults. Register Discord Rich Presence
(best-effort, `Using Krypt <Tool>`, 2 https buttons, stop on quit) — that's the
marketing engine. Never fail silently; toast everything; build the in-app modal in
week one. Apply lightweight anti-rebrand protection to branding + RPC with a debug
bypass. Ship a single MIT `.exe` with a proper multi-size `.ico`, no ads, no
telemetry, and test the installer end-to-end. If every box in §13 is checked,
it's Krypt.
```
