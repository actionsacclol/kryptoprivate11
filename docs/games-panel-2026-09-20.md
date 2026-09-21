# Games panel — 2026-09-20

Asked for: a My Layout widget with some games — Snake, Flappy Crypto, the
Chrome dino runner, and Tetris; then (same day) 2048 as the last game, the
liquid backdrop showing through like the other panels, and no game running
before the player touches a key.

## Shape

- `src/games/logic.ts` — the rules only, no canvas, no DOM. Each game is a
  pure state machine (`new`, `step`, plain inputs) with a seeded random
  source (`mulberry32`), so `test/games.test.mjs` drives every game to its
  ending without a browser: snake eats, grows, refuses to reverse, dies on a
  wall and on itself; the coin flaps between red candles, scores through the
  gap and dies on one; the dino jumps in an arc, speeds up, dies on a cactus
  and ducks under a bird; Tetris has seven pieces in four rotations from a
  7-bag, moves, rotates with wall kicks, clears a line, scores and tops out;
  2048 slides and merges once per move, spawns on a real move, wins at 2048
  and ends when stuck.
- `src/panels/GamesBody.tsx` — one canvas, the clock, the keys, the pointer
  and the drawing. Game tabs, score and best (per game, in localStorage),
  Restart. Arrows or WASD, Space, P pauses, R restarts. Nothing is fetched:
  shapes and text on a TRANSPARENT canvas (cleared each frame, a faint tint
  for legibility), so the app's liquid backdrop shows through the panel as
  it does on every other panel, the panel costs no request and the CSP stays
  closed.
- Registered as `games` in `src/panels/registry.tsx`.

## The four things that matter more than the games

1. **Keys never leave the panel.** The trading hotkeys listen on the window
   in the capture phase. The play area is a focusable element marked
   `data-swallows-keys`; `useHotkeys.isTyping` now treats anything inside
   one like a text field, and every handled key is stopped in the panel as
   well. Nothing is bound to Escape (it closes a popped-out panel) or Alt
   (token tabs).
2. **Nothing moves until the player does.** Picking a tab or focusing the
   panel shows the board; the first handled key (or a click, for the
   flappers) starts the clock. A snake that ran the moment its tab was
   clicked died before the hand reached the keys.
3. **It only runs while looked at.** The loop starts on focus and stops on
   blur or when the window is hidden. A game behind a chart costs nothing;
   a game that lost focus is paused, not lost.
4. **A resize restarts the free-running games** (their world is the canvas)
   and only repaints the grid ones.

## Verified live

`npm run test:games:e2e` against the running dev app: the play area renders,
the canvas has pixels, it takes focus, frames are drawn on a real ArrowRight
sent through the DevTools protocol, the clock stops on blur, all five games
switch in, and a key in the play area counts as typing for the hotkey guard.

One finding on the way, worth knowing for every future live check: after a
`TERMS_VERSION` bump the dev profile shows the legal gate, and the gate makes
the whole shell `inert` — nothing behind it takes focus or a mouse hit, while
script clicks still work. The driver lifts the attribute for the check (DOM
only; it accepts nothing). It does not accept the terms for the user.

Typecheck clean; 132 suites pass (13 games checks).
