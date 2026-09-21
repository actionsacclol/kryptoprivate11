// The Games panel — Snake, Flappy Crypto, Dino, Tetris and 2048 on one
// canvas, for the wait between candles.
//
// The rules live in src/games/logic.ts and are tested there; this file owns
// the clock, the keys, the pointer and the drawing. Four things matter more
// than the games:
//
//   1. KEYS NEVER LEAVE THE PANEL. The trading hotkeys listen on the window
//      in the capture phase; a game's Space or arrow must not reach them.
//      The play area is a focusable element marked `data-swallows-keys`,
//      which useHotkeys treats like a text field, and every handled key is
//      stopped here as well. Nothing is bound to Escape (it closes a popped
//      out panel) or Alt (token tabs).
//   2. NOTHING MOVES UNTIL THE PLAYER DOES. Picking a game or focusing the
//      panel shows the board; the first key (or click, for the flappers)
//      starts the clock. A snake that ran the moment its tab was clicked
//      died before the hand reached the keys (user report, 2026-09-20).
//   3. IT ONLY RUNS WHILE LOOKED AT. The loop stops when the play area loses
//      focus or the window is hidden, and starts again on focus — a game
//      cannot burn a core behind a chart, and a game that lost focus is
//      paused, not lost.
//   4. NOTHING IS FETCHED. No images, no fonts, no sounds: shapes and text on
//      a transparent canvas — the app's liquid backdrop shows through the
//      panel here as it does on every other panel — so the panel costs no
//      request and the CSP stays closed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DINO,
  FLAPPY,
  G2048_SIZE,
  TET_INDEX,
  dinoNew,
  dinoStep,
  flappyNew,
  flappyStep,
  g2048Move,
  g2048New,
  mulberry32,
  snakeNew,
  snakeStep,
  snakeTickMs,
  snakeTurn,
  tetrisCells,
  tetrisDrop,
  tetrisDropMs,
  tetrisGhost,
  tetrisHardDrop,
  tetrisMove,
  tetrisNew,
  tetrisRotate,
  type Dir,
  type DinoState,
  type FlappyState,
  type G2048State,
  type SnakeState,
  type TetrisState,
} from '../games/logic';
import { cls } from '../utils/format';

type GameId = 'snake' | 'flappy' | 'dino' | 'tetris' | 'g2048';
const GAMES: Array<{ id: GameId; label: string; hint: string; start: string }> = [
  { id: 'snake', label: 'Snake', hint: 'Arrows or WASD to steer', start: 'Press an arrow to start' },
  { id: 'flappy', label: 'Flappy Crypto', hint: 'Space, ↑ or click to flap', start: 'Space or click to flap off' },
  { id: 'dino', label: 'Dino', hint: 'Space or ↑ to jump, ↓ to duck', start: 'Space to run' },
  { id: 'tetris', label: 'Tetris', hint: '← → move, ↑ rotate, ↓ soft drop, Space hard drop', start: 'Press any key to start' },
  { id: 'g2048', label: '2048', hint: 'Arrows or WASD to slide', start: 'Slide with an arrow to start' },
];

const BEST_KEY = 'krypt.games.best.v1';
const GAME_KEY = 'krypt.games.last.v1';
type Best = Partial<Record<GameId, number>>;
const loadBest = (): Best => {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Best) : {};
  } catch {
    return {};
  }
};
const saveBest = (b: Best): void => {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* a best that cannot be remembered is still shown this session */
  }
};
const loadGame = (): GameId => {
  try {
    const v = localStorage.getItem(GAME_KEY);
    return GAMES.some((g) => g.id === v) ? (v as GameId) : 'snake';
  } catch {
    return 'snake';
  }
};

// Palette — the app's own semantic colours, as constants because a canvas
// cannot read CSS variables cheaply on every frame. The canvas itself is
// transparent; `tint` is the faint wash that keeps pieces legible over the
// backdrop without hiding it.
const C = {
  tint: 'rgba(8,8,14,0.32)',
  grid: 'rgba(240,237,226,0.07)',
  up: '#34d399',
  down: '#f43f5e',
  gold: '#D9B45B',
  purple: '#8b5cf6',
  text: '#F0EDE2',
  muted: '#8C92AB',
  ink: '#0b0b12',
};
const TET_COLORS = ['', '#22d3ee', '#D9B45B', '#a78bfa', '#34d399', '#f43f5e', '#60a5fa', '#fb923c'];
const TILE_COLORS: Record<number, string> = {
  2: 'rgba(240,237,226,0.16)',
  4: 'rgba(240,237,226,0.26)',
  8: 'rgba(217,180,91,0.55)',
  16: 'rgba(217,180,91,0.75)',
  32: 'rgba(251,146,60,0.8)',
  64: 'rgba(244,63,94,0.8)',
  128: 'rgba(139,92,246,0.75)',
  256: 'rgba(139,92,246,0.9)',
  512: 'rgba(52,211,153,0.8)',
  1024: 'rgba(52,211,153,0.95)',
  2048: '#D9B45B',
};

interface Session {
  game: GameId;
  rng: () => number;
  snake?: SnakeState;
  flappy?: FlappyState;
  dino?: DinoState;
  tetris?: TetrisState;
  g2048?: G2048State;
  /** The player has made a first move; the clock runs from here. */
  started: boolean;
  /** Accumulator for fixed-step games (ms). */
  acc: number;
  /** One-shot inputs consumed by the next update. */
  flap: boolean;
  jump: boolean;
  /** Held keys. */
  held: Set<string>;
  over: boolean;
  score: number;
}

function newSession(game: GameId, w: number, h: number): Session {
  const rng = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  const s: Session = { game, rng, started: false, acc: 0, flap: false, jump: false, held: new Set(), over: false, score: 0 };
  if (game === 'snake') {
    const cell = Math.max(12, Math.min(24, Math.floor(Math.min(w / 20, h / 14))));
    s.snake = snakeNew(Math.max(10, Math.floor(w / cell)), Math.max(8, Math.floor(h / cell)), rng);
  } else if (game === 'flappy') s.flappy = flappyNew(w, h);
  else if (game === 'dino') s.dino = dinoNew(w, h);
  else if (game === 'tetris') s.tetris = tetrisNew(rng);
  else s.g2048 = g2048New(rng);
  return s;
}

function scoreOf(s: Session): number {
  if (s.snake) return s.snake.score;
  if (s.flappy) return s.flappy.score;
  if (s.dino) return Math.floor(s.dino.score);
  if (s.tetris) return s.tetris.score;
  if (s.g2048) return s.g2048.score;
  return 0;
}
function overOf(s: Session): boolean {
  return !!(s.snake?.over || s.flappy?.over || s.dino?.over || s.tetris?.over || s.g2048?.over);
}

/** Advance the session by `dt` ms. Nothing moves before the first input. */
function update(s: Session, dt: number): void {
  if (!s.started) return;
  if (s.snake) {
    s.acc += dt;
    const tick = snakeTickMs(s.snake.score);
    while (s.acc >= tick && !s.snake.over) {
      s.acc -= tick;
      s.snake = snakeStep(s.snake, s.rng);
    }
  } else if (s.flappy) {
    s.flappy = flappyStep(s.flappy, dt / 1000, s.flap, s.rng);
    s.flap = false;
  } else if (s.dino) {
    s.dino = dinoStep(s.dino, dt / 1000, { jump: s.jump || s.held.has('ArrowUp') || s.held.has(' '), duck: s.held.has('ArrowDown') || s.held.has('s') }, s.rng);
    s.jump = false;
  } else if (s.tetris) {
    s.acc += dt;
    const soft = s.held.has('ArrowDown') || s.held.has('s');
    const tick = soft ? Math.min(60, tetrisDropMs(s.tetris.level)) : tetrisDropMs(s.tetris.level);
    while (s.acc >= tick && !s.tetris.over) {
      s.acc -= tick;
      s.tetris = tetrisDrop(s.tetris, s.rng);
    }
  }
  // 2048 is turn-based: every change happens in press().
  s.score = scoreOf(s);
  s.over = overOf(s);
}

const dirOf = (key: string): Dir | null =>
  key === 'ArrowUp' || key === 'w' ? 'up' : key === 'ArrowDown' || key === 's' ? 'down' : key === 'ArrowLeft' || key === 'a' ? 'left' : key === 'ArrowRight' || key === 'd' ? 'right' : null;

/** A key press, before the frame it lands in. Returns true when handled;
 *  a handled key is also what starts the clock. */
function press(s: Session, key: string): boolean {
  let handled = false;
  if (s.snake) {
    const dir = dirOf(key);
    if (dir) {
      s.snake = snakeTurn(s.snake, dir);
      handled = true;
    }
  } else if (s.flappy) {
    if (key === ' ' || key === 'ArrowUp' || key === 'w') {
      s.flap = true;
      handled = true;
    }
  } else if (s.dino) {
    if (key === ' ' || key === 'ArrowUp' || key === 'w') {
      s.jump = true;
      handled = true;
    } else handled = key === 'ArrowDown' || key === 's';
  } else if (s.tetris) {
    if (key === 'ArrowLeft' || key === 'a') s.tetris = tetrisMove(s.tetris, -1);
    else if (key === 'ArrowRight' || key === 'd') s.tetris = tetrisMove(s.tetris, 1);
    else if (key === 'ArrowUp' || key === 'w') s.tetris = tetrisRotate(s.tetris);
    else if (key === ' ') s.tetris = tetrisHardDrop(s.tetris, s.rng);
    handled = ['ArrowLeft', 'a', 'ArrowRight', 'd', 'ArrowUp', 'w', ' ', 'ArrowDown', 's'].includes(key);
  } else if (s.g2048) {
    const dir = dirOf(key);
    if (dir) {
      s.g2048 = g2048Move(s.g2048, dir, s.rng);
      handled = true;
    }
  }
  if (handled) s.started = true;
  s.score = scoreOf(s);
  s.over = overOf(s);
  return handled;
}

// ── Drawing ───────────────────────────────────────────────────────────

function drawSnake(g: CanvasRenderingContext2D, w: number, h: number, st: SnakeState): void {
  const cell = Math.min(w / st.cols, h / st.rows);
  const ox = (w - cell * st.cols) / 2;
  const oy = (h - cell * st.rows) / 2;
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  g.strokeRect(ox + 0.5, oy + 0.5, cell * st.cols - 1, cell * st.rows - 1);
  g.fillStyle = C.gold;
  g.beginPath();
  g.arc(ox + (st.food.x + 0.5) * cell, oy + (st.food.y + 0.5) * cell, cell * 0.32, 0, Math.PI * 2);
  g.fill();
  st.snake.forEach((c, i) => {
    g.fillStyle = i === 0 ? C.up : `rgba(52,211,153,${Math.max(0.35, 0.9 - i * 0.02)})`;
    g.fillRect(ox + c.x * cell + 1, oy + c.y * cell + 1, cell - 2, cell - 2);
  });
}

function drawFlappy(g: CanvasRenderingContext2D, st: FlappyState): void {
  for (const p of st.pipes) {
    // Red candles: a body above and below the gap, a thin wick into the gap.
    g.fillStyle = C.down;
    g.fillRect(p.x, 0, FLAPPY.pipeW, p.gapY);
    g.fillRect(p.x, p.gapY + FLAPPY.gap, FLAPPY.pipeW, st.h - p.gapY - FLAPPY.gap);
    g.fillStyle = 'rgba(244,63,94,0.5)';
    g.fillRect(p.x + FLAPPY.pipeW / 2 - 1, p.gapY, 2, 14);
    g.fillRect(p.x + FLAPPY.pipeW / 2 - 1, p.gapY + FLAPPY.gap - 14, 2, 14);
  }
  g.save();
  g.translate(st.x, st.y);
  g.rotate(Math.max(-0.5, Math.min(0.9, st.vy / 900)));
  g.fillStyle = C.gold;
  g.beginPath();
  g.arc(0, 0, st.r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = C.ink;
  g.font = `bold ${Math.round(st.r * 1.3)}px ui-monospace, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('◎', 0, 1);
  g.restore();
  g.fillStyle = C.grid;
  g.fillRect(0, st.h - 1, st.w, 1);
}

function drawDino(g: CanvasRenderingContext2D, st: DinoState): void {
  const ground = st.h - 24;
  g.strokeStyle = 'rgba(240,237,226,0.25)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, ground + 0.5);
  g.lineTo(st.w, ground + 0.5);
  g.stroke();
  for (const o of st.obstacles) {
    const y = ground - o.lift - o.h;
    if (o.lift > 0) {
      // A bird: two wedges.
      g.fillStyle = C.down;
      g.beginPath();
      g.moveTo(o.x, y + o.h / 2);
      g.lineTo(o.x + o.w / 2, y);
      g.lineTo(o.x + o.w, y + o.h / 2);
      g.lineTo(o.x + o.w / 2, y + o.h);
      g.closePath();
      g.fill();
    } else {
      g.fillStyle = C.up;
      const arms = Math.max(1, Math.round(o.w / 18));
      for (let i = 0; i < arms; i++) g.fillRect(o.x + i * 18, y + (i % 2) * 8, 10, o.h - (i % 2) * 8);
    }
  }
  const dh = st.ducking ? DINO.duckHeight : DINO.height;
  const dw = st.ducking ? DINO.width + 12 : DINO.width;
  const x = 40;
  const y = ground - st.y - dh;
  g.fillStyle = C.text;
  g.fillRect(x, y, dw, dh);
  g.fillStyle = C.ink;
  g.fillRect(x + dw - 10, y + 6, 4, 4);
  g.fillStyle = C.text;
  g.fillRect(x - 8, y + dh - 16, 10, 6);
}

function drawTetris(g: CanvasRenderingContext2D, w: number, h: number, st: TetrisState): void {
  const cell = Math.floor(Math.min(h / st.rows, (w - 70) / st.cols));
  const bw = cell * st.cols;
  const bh = cell * st.rows;
  const ox = Math.floor((w - bw - 70) / 2);
  const oy = Math.floor((h - bh) / 2);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(ox, oy, bw, bh);
  g.strokeStyle = C.grid;
  for (let x = 1; x < st.cols; x++) {
    g.beginPath();
    g.moveTo(ox + x * cell + 0.5, oy);
    g.lineTo(ox + x * cell + 0.5, oy + bh);
    g.stroke();
  }
  const block = (x: number, y: number, color: string, alpha = 1): void => {
    if (y < 0) return;
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(ox + x * cell + 1, oy + y * cell + 1, cell - 2, cell - 2);
    g.globalAlpha = 1;
  };
  st.board.forEach((row, y) => row.forEach((v, x) => v && block(x, y, TET_COLORS[v])));
  const ghost = tetrisGhost(st);
  for (const c of tetrisCells(ghost)) block(c.x, c.y, TET_COLORS[TET_INDEX[st.piece.kind]], 0.22);
  for (const c of tetrisCells(st.piece)) block(c.x, c.y, TET_COLORS[TET_INDEX[st.piece.kind]]);
  // Next piece and the counters, to the right.
  const px = ox + bw + 14;
  g.fillStyle = C.muted;
  g.font = '10px ui-monospace, monospace';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText('NEXT', px, oy);
  const nc = Math.max(8, Math.floor(cell * 0.7));
  for (const c of tetrisCells({ kind: st.next, rot: 0, x: 0, y: 0 })) {
    g.fillStyle = TET_COLORS[TET_INDEX[st.next]];
    g.fillRect(px + c.x * nc, oy + 14 + c.y * nc, nc - 1, nc - 1);
  }
  g.fillStyle = C.muted;
  g.fillText(`LVL ${st.level}`, px, oy + 14 + nc * 4 + 6);
  g.fillText(`LINES ${st.lines}`, px, oy + 14 + nc * 4 + 20);
}

function draw2048(g: CanvasRenderingContext2D, w: number, h: number, st: G2048State): void {
  const n = G2048_SIZE;
  const gap = 6;
  const side = Math.floor(Math.min(w, h)) - gap;
  const cell = Math.floor((side - gap * (n - 1)) / n);
  const ox = Math.floor((w - (cell * n + gap * (n - 1))) / 2);
  const oy = Math.floor((h - (cell * n + gap * (n - 1))) / 2);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < st.cells.length; i++) {
    const v = st.cells[i];
    const x = ox + (i % n) * (cell + gap);
    const y = oy + Math.floor(i / n) * (cell + gap);
    g.fillStyle = v ? (TILE_COLORS[v] ?? C.gold) : 'rgba(240,237,226,0.06)';
    g.fillRect(x, y, cell, cell);
    if (!v) continue;
    const digits = String(v).length;
    g.fillStyle = v >= 8 ? C.ink : C.text;
    g.font = `bold ${Math.floor(cell * (digits <= 2 ? 0.48 : digits === 3 ? 0.38 : 0.3))}px ui-monospace, monospace`;
    g.fillText(String(v), x + cell / 2, y + cell / 2 + 1);
  }
}

function draw(g: CanvasRenderingContext2D, w: number, h: number, s: Session): void {
  // Transparent: the panel's backdrop shows through, as on every other
  // panel; the tint keeps pieces legible over it.
  g.clearRect(0, 0, w, h);
  g.fillStyle = C.tint;
  g.fillRect(0, 0, w, h);
  if (s.snake) drawSnake(g, w, h, s.snake);
  else if (s.flappy) drawFlappy(g, s.flappy);
  else if (s.dino) drawDino(g, s.dino);
  else if (s.tetris) drawTetris(g, w, h, s.tetris);
  else if (s.g2048) draw2048(g, w, h, s.g2048);
}

// ── The panel ─────────────────────────────────────────────────────────

export function GamesBody(): ReactNode {
  const [game, setGame] = useState<GameId>(loadGame);
  const [best, setBest] = useState<Best>(loadBest);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [won, setWon] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 300, h: 200 });
  const sessionRef = useRef<Session | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const bestRef = useRef(best);
  bestRef.current = best;

  const paint = useCallback((): void => {
    const canvas = canvasRef.current;
    const s = sessionRef.current;
    if (!canvas || !s) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = sizeRef.current;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g, w, h, s);
  }, []);

  /** The score, the ending and the best, after any change. */
  const settle = useCallback((s: Session): void => {
    setScore(s.score);
    setWon(!!s.g2048?.won);
    if (s.over) {
      setOver(true);
      const b = bestRef.current;
      if (s.score > (b[s.game] ?? 0)) {
        const next = { ...b, [s.game]: s.score };
        setBest(next);
        saveBest(next);
      }
    }
  }, []);

  const restart = useCallback(
    (id: GameId = game): void => {
      const { w, h } = sizeRef.current;
      sessionRef.current = newSession(id, w, h);
      lastRef.current = performance.now();
      setScore(0);
      setOver(false);
      setWon(false);
      setStarted(false);
      paint();
    },
    [game, paint],
  );

  // Size follows the panel; a resize restarts the free-running games (their
  // world IS the canvas) and only repaints the others.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const w = Math.max(160, Math.floor(box.clientWidth));
      const h = Math.max(120, Math.floor(box.clientHeight));
      const changed = w !== sizeRef.current.w || h !== sizeRef.current.h;
      sizeRef.current = { w, h };
      const s = sessionRef.current;
      if (changed && s && (s.flappy || s.dino)) restart(s.game);
      else paint();
    });
    ro.observe(box);
    sizeRef.current = { w: Math.max(160, Math.floor(box.clientWidth)), h: Math.max(120, Math.floor(box.clientHeight)) };
    if (!sessionRef.current) restart(game);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The loop: only while focused and visible.
  useEffect(() => {
    if (!running) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    lastRef.current = performance.now();
    const frame = (now: number): void => {
      const s = sessionRef.current;
      if (s) {
        const dt = Math.min(50, now - lastRef.current);
        lastRef.current = now;
        if (!s.over) {
          const before = s.score;
          update(s, dt);
          if (s.score !== before || s.over) settle(s);
        }
        paint();
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    const onVis = (): void => {
      if (document.hidden) setRunning(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [running, paint, settle]);

  const pick = (id: GameId): void => {
    setGame(id);
    try {
      localStorage.setItem(GAME_KEY, id);
    } catch {
      /* the choice just resets next launch */
    }
    restart(id);
    boxRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const s = sessionRef.current;
    if (!s) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = false;
    if (key === 'r') {
      restart(s.game);
      handled = true;
    } else if (key === 'p') {
      setRunning((r) => !r);
      handled = true;
    } else if (s.over) {
      if (key === ' ' || key === 'Enter') {
        restart(s.game);
        handled = true;
      }
    } else {
      s.held.add(key);
      const wasStarted = s.started;
      if (!e.repeat || s.tetris) handled = press(s, key) || handled;
      if (!handled && (key === 'ArrowDown' || key === 's' || key === 'ArrowUp' || key === ' ')) handled = true;
      if (s.started && !wasStarted) setStarted(true);
      if (s.g2048) {
        settle(s);
        paint();
      }
      if (!running) setRunning(true);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const s = sessionRef.current;
    if (!s) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (s.held.delete(key)) e.stopPropagation();
  };
  const onPointer = (): void => {
    const s = sessionRef.current;
    boxRef.current?.focus();
    if (!s) return;
    if (s.over) {
      restart(s.game);
      return;
    }
    // A click flaps or jumps; on the other games it only focuses.
    if (s.flappy || s.dino) {
      if (s.flappy) s.flap = true;
      if (s.dino) s.jump = true;
      if (!s.started) {
        s.started = true;
        setStarted(true);
      }
    }
    if (!running) setRunning(true);
  };

  const meta = GAMES.find((g) => g.id === game) ?? GAMES[0];
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {GAMES.map((g) => (
          <button
            key={g.id}
            onClick={() => pick(g.id)}
            className={cls(
              'panel-action no-drag rounded border px-2 py-0.5 text-micro font-semibold transition',
              g.id === game ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
            )}
          >
            {g.label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="font-mono text-micro text-krypt-muted">
          <span className="text-white">{score}</span>
          {typeof best[game] === 'number' && <span> · best {best[game]}</span>}
        </span>
        <button onClick={() => restart(game)} className="panel-action no-drag text-micro text-krypt-muted hover:text-white" title="Restart (R)">
          Restart
        </button>
      </div>
      {/* The play area. Focus arms the clock, the first key starts it, blur
          stops it. Marked so the trading hotkeys treat it like a text field
          — see useHotkeys. Transparent, so the panel's backdrop shows. */}
      <div
        ref={boxRef}
        tabIndex={0}
        data-swallows-keys=""
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerDown={onPointer}
        onFocus={() => setRunning(true)}
        onBlur={() => setRunning(false)}
        className="no-drag relative min-h-0 flex-1 cursor-pointer overflow-hidden rounded border border-white/10 outline-none focus:border-krypt-purple/50"
        aria-label={`${meta.label} — ${meta.hint}`}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
        {(!running || over || !started) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/35 text-center">
            <div className="font-display text-sm font-semibold text-white">
              {over ? `Game over · ${score}${won ? ' · you made 2048' : ''}` : !running ? 'Click to play' : meta.label}
            </div>
            <div className="text-micro text-krypt-muted">{over ? 'Space, click or R to go again' : running ? meta.start : meta.hint}</div>
            {!over && <div className="text-micro text-krypt-muted/70">P pauses · R restarts</div>}
          </div>
        )}
        {won && !over && started && running && (
          <div className="pointer-events-none absolute right-2 top-2 rounded border border-arc-gold/40 bg-black/40 px-2 py-0.5 text-micro font-semibold text-arc-gold">2048</div>
        )}
      </div>
    </div>
  );
}
