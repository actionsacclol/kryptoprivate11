// The games on the Games panel — the RULES only, no canvas, no DOM.
//
// Four small games for the wait between candles: Snake, Flappy Crypto, Dino
// and Tetris. Each is a pure state machine: `new` makes a state, `step`
// advances it by one tick or by `dt` seconds, and the inputs are plain
// values. The panel (src/panels/GamesBody.tsx) owns the clock, the keys and
// the drawing. Keeping the rules here means test/games.test.mjs can drive
// every game to its ending with a seeded random source and no browser.

export type Rng = () => number;

/** Deterministic random in [0, 1) from a seed — tests replay a game exactly. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Snake ─────────────────────────────────────────────────────────────

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface Cell {
  x: number;
  y: number;
}
export interface SnakeState {
  cols: number;
  rows: number;
  /** Head first. */
  snake: Cell[];
  dir: Dir;
  /** The turn taken at the next step — one per step, so a fast double
   *  press cannot reverse the snake through itself. */
  pendingDir: Dir;
  food: Cell;
  score: number;
  over: boolean;
}

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DELTA: Record<Dir, Cell> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

function placeFood(cols: number, rows: number, snake: Cell[], rng: Rng): Cell {
  const taken = new Set(snake.map((c) => `${c.x},${c.y}`));
  const free = cols * rows - taken.size;
  if (free <= 0) return { x: -1, y: -1 };
  let n = Math.floor(rng() * free);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (taken.has(`${x},${y}`)) continue;
      if (n === 0) return { x, y };
      n--;
    }
  }
  return { x: -1, y: -1 };
}

export function snakeNew(cols: number, rows: number, rng: Rng): SnakeState {
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  const snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
  return { cols, rows, snake, dir: 'right', pendingDir: 'right', food: placeFood(cols, rows, snake, rng), score: 0, over: false };
}

/** A turn request. Reversing into the body is ignored. */
export function snakeTurn(s: SnakeState, dir: Dir): SnakeState {
  if (s.over || dir === OPPOSITE[s.dir] || dir === s.dir) return s;
  return { ...s, pendingDir: dir };
}

export function snakeStep(s: SnakeState, rng: Rng): SnakeState {
  if (s.over) return s;
  const dir = s.pendingDir;
  const head = s.snake[0];
  const next = { x: head.x + DELTA[dir].x, y: head.y + DELTA[dir].y };
  if (next.x < 0 || next.y < 0 || next.x >= s.cols || next.y >= s.rows) return { ...s, dir, over: true };
  const eats = next.x === s.food.x && next.y === s.food.y;
  // The tail moves out of the way unless the snake grows this step.
  const body = eats ? s.snake : s.snake.slice(0, -1);
  if (body.some((c) => c.x === next.x && c.y === next.y)) return { ...s, dir, over: true };
  const snake = [next, ...body];
  if (!eats) return { ...s, dir, snake };
  const food = placeFood(s.cols, s.rows, snake, rng);
  return { ...s, dir, snake, food, score: s.score + 1, over: food.x < 0 };
}

/** Milliseconds per step: quicker as the score climbs, never under 60. */
export function snakeTickMs(score: number): number {
  return Math.max(60, 140 - score * 4);
}

// ── Flappy Crypto ─────────────────────────────────────────────────────
// A coin flaps between red candles. Units are pixels and seconds.

export interface Pipe {
  x: number;
  /** Top of the gap. */
  gapY: number;
  passed: boolean;
}
export interface FlappyState {
  w: number;
  h: number;
  x: number;
  y: number;
  vy: number;
  r: number;
  pipes: Pipe[];
  score: number;
  started: boolean;
  over: boolean;
  /** Distance scrolled since the last pipe. */
  sinceSpawn: number;
}

export const FLAPPY = {
  gravity: 1700,
  flap: -480,
  speed: 170,
  gap: 150,
  pipeW: 54,
  spacing: 230,
  maxFall: 700,
} as const;

export function flappyNew(w: number, h: number): FlappyState {
  return { w, h, x: Math.round(w * 0.28), y: h / 2, vy: 0, r: 13, pipes: [], score: 0, started: false, over: false, sinceSpawn: FLAPPY.spacing };
}

export function flappyStep(s: FlappyState, dt: number, flap: boolean, rng: Rng): FlappyState {
  if (s.over) return s;
  if (!s.started) {
    if (!flap) return s;
    s = { ...s, started: true, vy: FLAPPY.flap };
  } else if (flap) {
    s = { ...s, vy: FLAPPY.flap };
  }
  const vy = Math.min(FLAPPY.maxFall, s.vy + FLAPPY.gravity * dt);
  const y = s.y + vy * dt;
  const dx = FLAPPY.speed * dt;
  let pipes = s.pipes.map((p) => ({ ...p, x: p.x - dx })).filter((p) => p.x + FLAPPY.pipeW > 0);
  let sinceSpawn = s.sinceSpawn + dx;
  if (sinceSpawn >= FLAPPY.spacing) {
    sinceSpawn = 0;
    const margin = 40;
    const gapY = margin + rng() * Math.max(1, s.h - FLAPPY.gap - margin * 2);
    pipes = [...pipes, { x: s.w, gapY, passed: false }];
  }
  let score = s.score;
  for (const p of pipes) {
    if (!p.passed && p.x + FLAPPY.pipeW < s.x - s.r) {
      p.passed = true;
      score++;
    }
  }
  const hitFloor = y + s.r >= s.h || y - s.r <= 0;
  const hitPipe = pipes.some((p) => s.x + s.r > p.x && s.x - s.r < p.x + FLAPPY.pipeW && (y - s.r < p.gapY || y + s.r > p.gapY + FLAPPY.gap));
  return { ...s, y, vy, pipes, sinceSpawn, score, over: hitFloor || hitPipe };
}

// ── Dino ──────────────────────────────────────────────────────────────
// A runner on the ground line. Obstacles are cacti (ground) and birds
// (in the air — duck under them). Units are pixels and seconds.

export interface Obstacle {
  x: number;
  w: number;
  h: number;
  /** Height above the ground of the obstacle's bottom; 0 for a cactus. */
  lift: number;
}
export interface DinoState {
  w: number;
  h: number;
  /** Height of the dino's feet above the ground. */
  y: number;
  vy: number;
  ducking: boolean;
  obstacles: Obstacle[];
  speed: number;
  /** Distance run, in points. */
  score: number;
  started: boolean;
  over: boolean;
  sinceSpawn: number;
}

export const DINO = {
  gravity: 2400,
  jump: -780,
  baseSpeed: 260,
  maxSpeed: 620,
  accel: 6,
  width: 34,
  height: 40,
  duckHeight: 22,
  minGap: 280,
  gapJitter: 260,
  groundY: 0,
} as const;

export function dinoNew(w: number, h: number): DinoState {
  return { w, h, y: 0, vy: 0, ducking: false, obstacles: [], speed: DINO.baseSpeed, score: 0, started: false, over: false, sinceSpawn: 0 };
}

export function dinoStep(s: DinoState, dt: number, input: { jump: boolean; duck: boolean }, rng: Rng): DinoState {
  if (s.over) return s;
  if (!s.started) {
    if (!input.jump) return s;
    s = { ...s, started: true };
  }
  const onGround = s.y <= 0 && s.vy >= 0;
  let vy = s.vy;
  if (input.jump && onGround) vy = DINO.jump;
  // Ducking mid-air drops fast, as in the original.
  if (input.duck && !onGround) vy += DINO.gravity * dt * 2;
  vy += DINO.gravity * dt;
  let y = s.y - vy * dt;
  if (y <= 0) {
    y = 0;
    vy = 0;
  }
  const ducking = input.duck && y <= 0;
  const speed = Math.min(DINO.maxSpeed, s.speed + DINO.accel * dt);
  const dx = speed * dt;
  let obstacles = s.obstacles.map((o) => ({ ...o, x: o.x - dx })).filter((o) => o.x + o.w > 0);
  let sinceSpawn = s.sinceSpawn + dx;
  const nextGap = DINO.minGap + rng() * DINO.gapJitter;
  if (sinceSpawn >= nextGap) {
    sinceSpawn = 0;
    const bird = s.score > 300 && rng() < 0.25;
    const size = 1 + Math.floor(rng() * 3);
    obstacles = bird
      ? [...obstacles, { x: s.w, w: 40, h: 22, lift: rng() < 0.5 ? 36 : 70 }]
      : [...obstacles, { x: s.w, w: 14 * size + 4, h: 30 + (size - 1) * 8, lift: 0 }];
  }
  const score = s.score + speed * dt * 0.06;
  const dinoX = 40;
  const dinoH = ducking ? DINO.duckHeight : DINO.height;
  const dinoW = ducking ? DINO.width + 12 : DINO.width;
  const hit = obstacles.some((o) => dinoX + dinoW - 4 > o.x && dinoX + 4 < o.x + o.w && y < o.lift + o.h && y + dinoH > o.lift);
  return { ...s, y, vy, ducking, obstacles, speed, score, sinceSpawn, over: hit };
}

// ── Tetris ────────────────────────────────────────────────────────────

export type TetKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export const TET_KINDS: TetKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
/** Rotation states as cell matrices, clockwise from spawn. */
export const TETROMINOES: Record<TetKind, number[][][]> = {
  I: [
    [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]],
    [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]],
    [[0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0]],
  ],
  O: [[[1, 1], [1, 1]], [[1, 1], [1, 1]], [[1, 1], [1, 1]], [[1, 1], [1, 1]]],
  T: [
    [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 1, 0], [0, 1, 0]],
  ],
  S: [
    [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 1], [0, 0, 1]],
    [[0, 0, 0], [0, 1, 1], [1, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
  ],
  Z: [
    [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    [[0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 0], [0, 1, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 0, 0]],
  ],
  J: [
    [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 1], [0, 1, 0], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 0], [1, 1, 0]],
  ],
  L: [
    [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 0], [0, 1, 1]],
    [[0, 0, 0], [1, 1, 1], [1, 0, 0]],
    [[1, 1, 0], [0, 1, 0], [0, 1, 0]],
  ],
};
/** 1-based colour index per kind, stored in the board. */
export const TET_INDEX: Record<TetKind, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };

export interface Piece {
  kind: TetKind;
  rot: number;
  x: number;
  y: number;
}
export interface TetrisState {
  cols: number;
  rows: number;
  /** rows × cols, 0 = empty, else TET_INDEX. */
  board: number[][];
  piece: Piece;
  next: TetKind;
  /** The 7-bag the next pieces come from. */
  bag: TetKind[];
  score: number;
  lines: number;
  level: number;
  over: boolean;
}

function drawBag(bag: TetKind[], rng: Rng): { kind: TetKind; bag: TetKind[] } {
  let b = bag;
  if (b.length === 0) {
    b = [...TET_KINDS];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
  }
  return { kind: b[0], bag: b.slice(1) };
}

export function tetrisCells(p: Piece): Cell[] {
  const m = TETROMINOES[p.kind][p.rot % 4];
  const out: Cell[] = [];
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) if (m[r][c]) out.push({ x: p.x + c, y: p.y + r });
  return out;
}

function fits(board: number[][], p: Piece): boolean {
  const rows = board.length;
  const cols = board[0].length;
  return tetrisCells(p).every((c) => c.x >= 0 && c.x < cols && c.y < rows && (c.y < 0 || board[c.y][c.x] === 0));
}

function spawn(kind: TetKind, cols: number): Piece {
  const width = TETROMINOES[kind][0][0].length;
  return { kind, rot: 0, x: Math.floor((cols - width) / 2), y: kind === 'I' ? -1 : 0 };
}

export function tetrisNew(rng: Rng, cols = 10, rows = 20): TetrisState {
  const board = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  const first = drawBag([], rng);
  const second = drawBag(first.bag, rng);
  return { cols, rows, board, piece: spawn(first.kind, cols), next: second.kind, bag: second.bag, score: 0, lines: 0, level: 1, over: false };
}

export function tetrisMove(s: TetrisState, dx: number): TetrisState {
  if (s.over) return s;
  const p = { ...s.piece, x: s.piece.x + dx };
  return fits(s.board, p) ? { ...s, piece: p } : s;
}

/** Rotate clockwise, trying the plain turn then one-cell kicks left, right and up. */
export function tetrisRotate(s: TetrisState): TetrisState {
  if (s.over) return s;
  const rot = (s.piece.rot + 1) % 4;
  for (const [kx, ky] of [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0]]) {
    const p = { ...s.piece, rot, x: s.piece.x + kx, y: s.piece.y + ky };
    if (fits(s.board, p)) return { ...s, piece: p };
  }
  return s;
}

const LINE_SCORE = [0, 100, 300, 500, 800];

function lock(s: TetrisState, rng: Rng): TetrisState {
  const board = s.board.map((row) => [...row]);
  let topOut = false;
  for (const c of tetrisCells(s.piece)) {
    if (c.y < 0) {
      topOut = true;
      continue;
    }
    board[c.y][c.x] = TET_INDEX[s.piece.kind];
  }
  const kept = board.filter((row) => row.some((v) => v === 0));
  const cleared = board.length - kept.length;
  while (kept.length < s.rows) kept.unshift(Array<number>(s.cols).fill(0));
  const lines = s.lines + cleared;
  const level = 1 + Math.floor(lines / 10);
  const score = s.score + LINE_SCORE[cleared] * s.level;
  const drawn = drawBag(s.bag, rng);
  const piece = spawn(s.next, s.cols);
  const over = topOut || !fits(kept, piece);
  return { ...s, board: kept, piece, next: drawn.kind, bag: drawn.bag, score, lines, level, over };
}

/** One gravity step: down if it fits, else lock and spawn. */
export function tetrisDrop(s: TetrisState, rng: Rng): TetrisState {
  if (s.over) return s;
  const p = { ...s.piece, y: s.piece.y + 1 };
  return fits(s.board, p) ? { ...s, piece: p } : lock(s, rng);
}

/** Straight to the floor and lock. */
export function tetrisHardDrop(s: TetrisState, rng: Rng): TetrisState {
  if (s.over) return s;
  let p = s.piece;
  let n = 0;
  while (fits(s.board, { ...p, y: p.y + 1 })) {
    p = { ...p, y: p.y + 1 };
    n++;
  }
  return lock({ ...s, piece: p, score: s.score + n * 2 }, rng);
}

/** Where the piece would land — the ghost. */
export function tetrisGhost(s: TetrisState): Piece {
  let p = s.piece;
  while (fits(s.board, { ...p, y: p.y + 1 })) p = { ...p, y: p.y + 1 };
  return p;
}

/** Milliseconds per gravity step at a level: 800 at 1, never under 80. */
export function tetrisDropMs(level: number): number {
  return Math.max(80, Math.round(800 * Math.pow(0.85, level - 1)));
}

// ── 2048 ──────────────────────────────────────────────────────────────
// A 4×4 board, row-major. Slide every tile as far as it goes, merge equal
// neighbours ONCE per move, spawn a 2 (or a 4, one time in ten) in a free
// cell when something moved. Over when no slide can change the board.

export const G2048_SIZE = 4;
export interface G2048State {
  cells: number[];
  score: number;
  over: boolean;
  /** A 2048 tile has been made; play continues. */
  won: boolean;
}

/** One line slid toward index 0: compress, merge pairs once, compress. */
export function slideLine(line: number[]): { line: number[]; gained: number } {
  const packed = line.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < packed.length; i++) {
    if (i + 1 < packed.length && packed[i] === packed[i + 1]) {
      out.push(packed[i] * 2);
      gained += packed[i] * 2;
      i++;
    } else out.push(packed[i]);
  }
  while (out.length < line.length) out.push(0);
  return { line: out, gained };
}

function spawnTile(cells: number[], rng: Rng): number[] {
  const free = cells.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (!free.length) return cells;
  const at = free[Math.floor(rng() * free.length)];
  const next = [...cells];
  next[at] = rng() < 0.1 ? 4 : 2;
  return next;
}

export function g2048CanMove(cells: number[]): boolean {
  const n = G2048_SIZE;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 0) return true;
    const x = i % n;
    const y = Math.floor(i / n);
    if (x + 1 < n && cells[i] === cells[i + 1]) return true;
    if (y + 1 < n && cells[i] === cells[i + n]) return true;
  }
  return false;
}

export function g2048New(rng: Rng): G2048State {
  let cells = Array<number>(G2048_SIZE * G2048_SIZE).fill(0);
  cells = spawnTile(spawnTile(cells, rng), rng);
  return { cells, score: 0, over: false, won: false };
}

export function g2048Move(s: G2048State, dir: Dir, rng: Rng): G2048State {
  if (s.over) return s;
  const n = G2048_SIZE;
  const cells = [...s.cells];
  let gained = 0;
  // Read each line in the slide direction, slide it, write it back.
  for (let k = 0; k < n; k++) {
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      if (dir === 'left') idx.push(k * n + j);
      else if (dir === 'right') idx.push(k * n + (n - 1 - j));
      else if (dir === 'up') idx.push(j * n + k);
      else idx.push((n - 1 - j) * n + k);
    }
    const r = slideLine(idx.map((i) => cells[i]));
    gained += r.gained;
    idx.forEach((i, j) => {
      cells[i] = r.line[j];
    });
  }
  const moved = cells.some((v, i) => v !== s.cells[i]);
  if (!moved) return s;
  const next = spawnTile(cells, rng);
  return { cells: next, score: s.score + gained, won: s.won || next.some((v) => v >= 2048), over: !g2048CanMove(next) };
}
