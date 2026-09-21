// The Games panel's rules (src/games/logic.ts), driven to their endings with
// a seeded random source — and the one wiring fact that matters more than
// any game: a key pressed in the play area never reaches a trading hotkey.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  DINO,
  FLAPPY,
  TET_INDEX,
  TET_KINDS,
  TETROMINOES,
  dinoNew,
  dinoStep,
  flappyNew,
  flappyStep,
  g2048CanMove,
  g2048Move,
  g2048New,
  slideLine,
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
} from './.games.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()), 'same seed, same sequence');
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, mulberry32(8)));
  ok('the random source is seeded and replayable');
}

// ── Snake ──
{
  const rng = mulberry32(1);
  let s = snakeNew(12, 8, rng);
  assert.equal(s.snake.length, 3);
  assert.equal(s.dir, 'right');
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y), 'food is not on the snake');
  const head = s.snake[0];
  s = snakeStep(s, rng);
  assert.deepEqual(s.snake[0], { x: head.x + 1, y: head.y }, 'moves one cell right');
  assert.equal(s.snake.length, 3, 'no growth without food');
  // Reversal is refused; a real turn is taken on the next step, not before.
  assert.equal(snakeTurn(s, 'left').pendingDir, 'right', 'cannot reverse into itself');
  s = snakeTurn(s, 'down');
  assert.equal(s.dir, 'right', 'the turn waits for the step');
  s = snakeStep(s, rng);
  assert.equal(s.dir, 'down');
  ok('snake moves, refuses to reverse, turns on the step');
}
{
  // Eating grows the snake by one and moves the food; the wall ends it.
  const rng = mulberry32(2);
  let s = snakeNew(10, 6, rng);
  s = { ...s, food: { x: s.snake[0].x + 1, y: s.snake[0].y } };
  s = snakeStep(s, rng);
  assert.equal(s.score, 1);
  assert.equal(s.snake.length, 4, 'grew');
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y), 'new food is off the snake');
  let n = 0;
  while (!s.over && n < 100) {
    s = snakeStep(s, rng);
    n++;
  }
  assert.ok(s.over, 'ran into the wall');
  assert.ok(n < 20, `died in ${n} steps`);
  assert.equal(snakeStep(s, rng), s, 'a finished game does not move');
  assert.ok(snakeTickMs(0) > snakeTickMs(10) && snakeTickMs(1000) === 60, 'faster with score, floored');
  ok('snake eats, grows and dies on the wall');
}
{
  // Self-collision: a tight loop.
  const rng = mulberry32(3);
  let s = snakeNew(20, 20, rng);
  s = { ...s, snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }], dir: 'right', pendingDir: 'right' };
  s = snakeTurn(s, 'down');
  s = snakeStep(s, rng);
  assert.ok(s.over, 'turning down into its own body ends the game');
  ok('snake dies on itself');
}

// ── Flappy ──
{
  const rng = mulberry32(4);
  let s = flappyNew(400, 300);
  assert.equal(s.started, false);
  const idle = flappyStep(s, 0.5, false, rng);
  assert.equal(idle.y, s.y, 'nothing moves before the first flap');
  s = flappyStep(s, 1 / 60, true, rng);
  assert.ok(s.started && s.vy < 0, 'the first flap starts it and lifts');
  const y1 = s.y;
  for (let i = 0; i < 30; i++) s = flappyStep(s, 1 / 60, false, rng);
  assert.ok(s.vy > 0, 'gravity wins without flapping');
  assert.ok(s.pipes.length >= 1, 'pipes spawn');
  assert.ok(s.pipes.every((p) => p.gapY >= 40 && p.gapY + FLAPPY.gap <= s.h - 40), 'gaps stay on screen');
  // Fall to the floor.
  let n = 0;
  while (!s.over && n < 600) {
    s = flappyStep(s, 1 / 60, false, rng);
    n++;
  }
  assert.ok(s.over, 'hits the floor');
  assert.ok(s.y + s.r >= s.h || s.pipes.length > 0);
  assert.equal(flappyStep(s, 1 / 60, true, rng), s, 'no flapping after the end');
  void y1;
  ok('flappy: idle until the first flap, gravity, pipes, an ending');
}
{
  // Threading the gap scores; hitting a candle ends it.
  const rng = mulberry32(5);
  let s = flappyNew(400, 300);
  s = { ...s, started: true, pipes: [{ x: s.x - s.r - FLAPPY.pipeW - 1, gapY: 100, passed: false }], y: 150, vy: 0, sinceSpawn: 0 };
  s = flappyStep(s, 1 / 60, false, rng);
  assert.equal(s.score, 1, 'a pipe behind the coin counts once');
  s = flappyStep(s, 1 / 60, false, rng);
  assert.equal(s.score, 1, 'and only once');
  let t = flappyNew(400, 300);
  t = { ...t, started: true, pipes: [{ x: t.x - 5, gapY: 200, passed: false }], y: 60, vy: 0 };
  t = flappyStep(t, 1 / 60, false, rng);
  assert.ok(t.over, 'above the gap = into the candle');
  ok('flappy scores through the gap and dies on a candle');
}

// ── Dino ──
{
  const rng = mulberry32(6);
  let s = dinoNew(600, 200);
  assert.equal(dinoStep(s, 0.5, { jump: false, duck: false }, rng).started, false, 'waits for the first jump');
  s = dinoStep(s, 1 / 60, { jump: true, duck: false }, rng);
  assert.ok(s.started && s.y > 0, 'jumps');
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    s = dinoStep(s, 1 / 60, { jump: false, duck: false }, rng);
    peak = Math.max(peak, s.y);
  }
  assert.ok(peak > 60 && s.y === 0, `arc peaked at ${Math.round(peak)} and landed`);
  assert.ok(s.speed > DINO.baseSpeed, 'speeds up');
  assert.ok(s.score > 0, 'distance counts');
  const ducked = dinoStep(s, 1 / 60, { jump: false, duck: true }, rng);
  assert.equal(ducked.ducking, true, 'ducks on the ground');
  ok('dino: waits, jumps in an arc, speeds up, ducks');
}
{
  // Runs into a cactus without jumping; a bird is cleared by ducking.
  const rng = mulberry32(7);
  let s = dinoNew(600, 200);
  s = { ...s, started: true, obstacles: [{ x: 200, w: 18, h: 30, lift: 0 }] };
  let n = 0;
  while (!s.over && n < 300) {
    s = dinoStep(s, 1 / 60, { jump: false, duck: false }, rng);
    n++;
  }
  assert.ok(s.over, 'a cactus at head height ends it');
  let t = dinoNew(600, 200);
  t = { ...t, started: true, obstacles: [{ x: 60, w: 40, h: 22, lift: 36 }] };
  const hit = dinoStep(t, 1 / 60, { jump: false, duck: false }, rng);
  assert.ok(hit.over, 'standing into a low bird');
  const under = dinoStep(t, 1 / 60, { jump: false, duck: true }, rng);
  assert.equal(under.over, false, 'ducking clears it');
  ok('dino dies on a cactus and ducks under a bird');
}

// ── Tetris ──
{
  for (const k of TET_KINDS) assert.equal(TETROMINOES[k].length, 4, `${k} has four rotations`);
  for (const k of TET_KINDS) for (const m of TETROMINOES[k]) assert.equal(m.flat().filter(Boolean).length, 4, `${k} is four cells in every rotation`);
  const rng = mulberry32(8);
  const s = tetrisNew(rng);
  assert.equal(s.board.length, 20);
  assert.equal(s.board[0].length, 10);
  assert.ok(TET_KINDS.includes(s.piece.kind) && TET_KINDS.includes(s.next));
  assert.ok(tetrisCells(s.piece).every((c) => c.x >= 0 && c.x < 10), 'spawns inside');
  // The 7-bag: the first 7 pieces are all different.
  const seen = new Set();
  let t = s;
  seen.add(t.piece.kind);
  for (let i = 0; i < 6; i++) {
    t = tetrisHardDrop(t, rng);
    seen.add(t.piece.kind);
  }
  assert.equal(seen.size, 7, `seven different pieces first (${[...seen].join('')})`);
  ok('tetris: seven pieces, four rotations, a 7-bag, spawn inside');
}
{
  const rng = mulberry32(9);
  let s = tetrisNew(rng);
  const x0 = s.piece.x;
  s = tetrisMove(s, -1);
  assert.equal(s.piece.x, x0 - 1);
  for (let i = 0; i < 12; i++) s = tetrisMove(s, -1);
  assert.ok(tetrisCells(s.piece).every((c) => c.x >= 0), 'stops at the wall');
  const r = tetrisRotate(s);
  assert.equal(r.piece.rot, (s.piece.rot + 1) % 4);
  assert.ok(tetrisCells(r.piece).every((c) => c.x >= 0 && c.x < 10), 'rotation kicks off the wall');
  const g = tetrisGhost(s);
  assert.ok(g.y >= s.piece.y, 'the ghost is at or below the piece');
  const dropped = tetrisDrop(s, rng);
  assert.equal(dropped.piece.y, s.piece.y + 1, 'gravity moves one row');
  assert.ok(tetrisDropMs(1) > tetrisDropMs(5) && tetrisDropMs(50) === 80, 'faster per level, floored');
  ok('tetris moves, rotates with kicks, drops one row');
}
{
  // A full row clears and scores; the game ends when the stack reaches the top.
  const rng = mulberry32(10);
  let s = tetrisNew(rng);
  // Fill the bottom row except where an I piece will land vertically.
  const board = s.board.map((row) => [...row]);
  for (let x = 0; x < 10; x++) if (x !== 4) board[19][x] = 7;
  s = { ...s, board, piece: { kind: 'I', rot: 1, x: 2, y: 10 } };
  const cells = tetrisCells(s.piece);
  assert.ok(cells.every((c) => c.x === 4), 'the vertical I is in column 4');
  const after = tetrisHardDrop(s, rng);
  assert.equal(after.lines, 1, 'one line cleared');
  assert.equal(after.score >= 100, true, `scored ${after.score}`);
  // The cleared row is gone and the I's other three cells fell one row:
  // a single column in x=4, its lowest cell now on the bottom row.
  assert.equal(after.board.flat().filter(Boolean).length, 3, 'three cells of the I remain');
  assert.equal(after.board[19][4], TET_INDEX.I, 'the lowest one sits on the bottom row');
  assert.equal(after.board[19].filter(Boolean).length, 1, 'alone on that row');
  assert.equal(after.board[16].filter(Boolean).length, 0, 'the row above the I is empty');
  // Stack to the top → over.
  let t = tetrisNew(rng);
  let n = 0;
  while (!t.over && n < 400) {
    t = tetrisHardDrop(t, rng);
    n++;
  }
  assert.ok(t.over, `topped out after ${n} drops`);
  assert.equal(tetrisHardDrop(t, rng), t, 'nothing moves after the end');
  assert.equal(TET_INDEX.I, 1);
  ok('tetris clears a line, scores, and ends at the top');
}

// ── 2048 ──
{
  assert.deepEqual(slideLine([2, 2, 0, 0]), { line: [4, 0, 0, 0], gained: 4 });
  assert.deepEqual(slideLine([2, 2, 2, 2]), { line: [4, 4, 0, 0], gained: 8 }, 'each tile merges once per move');
  assert.deepEqual(slideLine([0, 2, 0, 2]), { line: [4, 0, 0, 0], gained: 4 }, 'gaps close before merging');
  assert.deepEqual(slideLine([4, 2, 2, 0]), { line: [4, 4, 0, 0], gained: 4 }, 'a merge does not chain into a new merge');
  assert.deepEqual(slideLine([2, 4, 8, 16]), { line: [2, 4, 8, 16], gained: 0 });
  const rng = mulberry32(11);
  const s = g2048New(rng);
  assert.equal(s.cells.length, 16);
  assert.equal(s.cells.filter(Boolean).length, 2, 'starts with two tiles');
  assert.ok(s.cells.every((v) => v === 0 || v === 2 || v === 4));
  // A move that changes nothing spawns nothing and is the same state.
  const wall = { cells: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, over: false, won: false };
  assert.equal(g2048Move(wall, 'left', rng), wall, 'sliding into the wall it already sits on is not a move');
  assert.equal(g2048Move(wall, 'right', rng), wall, 'a full row is flush against both walls');
  const down = g2048Move(wall, 'down', rng);
  assert.deepEqual(down.cells.slice(12, 16), [2, 4, 8, 16], 'the row slid to the bottom');
  assert.equal(down.cells.filter(Boolean).length, 5, 'a real move spawns one tile');
  const merge = g2048Move({ cells: [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, over: false, won: false }, 'left', rng);
  assert.equal(merge.cells[0], 4);
  assert.equal(merge.score, 4, 'the score is what merged');
  const up = g2048Move({ cells: [0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0], score: 0, over: false, won: false }, 'up', rng);
  assert.equal(up.cells[0], 4, 'columns slide too');
  // No free cell and no equal neighbours = over; a 2048 tile marks a win but play goes on.
  const stuck = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.equal(g2048CanMove(stuck), false);
  const lastMove = g2048Move({ cells: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 0], score: 0, over: false, won: false }, 'right', rng);
  assert.ok(lastMove.cells.filter(Boolean).length === 16 || lastMove.over || g2048CanMove(lastMove.cells), 'the board filled or can still move');
  const win = g2048Move({ cells: [1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 0, over: false, won: false }, 'left', rng);
  assert.equal(win.won, true);
  assert.equal(win.over, false, 'winning does not end the game');
  const ended = { cells: stuck, score: 1, over: true, won: false };
  assert.equal(g2048Move(ended, 'left', rng), ended, 'nothing moves after the end');
  ok('2048 slides, merges once per move, spawns on a real move, wins at 2048, ends when stuck');
}

// ── Wiring ──
{
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const hot = src('../src/state/useHotkeys.ts');
  assert.ok(/closest\('\[data-swallows-keys\]'\) !== null/.test(hot), 'a focused play area counts as typing for the trading hotkeys');
  const body = src('../src/panels/GamesBody.tsx');
  assert.ok(/data-swallows-keys=""/.test(body), 'the play area is marked');
  assert.ok(/e\.stopPropagation\(\)/.test(body) && /e\.preventDefault\(\)/.test(body), 'handled keys stop here');
  assert.ok(!/'Escape'/.test(body), 'Escape is not a game key (it closes a popped-out panel)');
  assert.ok(/onBlur=\{\(\) => setRunning\(false\)\}/.test(body) && /document\.hidden\) setRunning\(false\)/.test(body), 'the loop stops on blur and when hidden');
  assert.ok(!/fetch\(|new Image\(|<img/.test(body), 'nothing is fetched');
  // Nothing moves before the first input: picking a tab shows the board and waits.
  assert.ok(/function update\(s: Session, dt: number\): void \{\s*if \(!s\.started\) return;/.test(body), 'the clock waits for the first move');
  assert.ok(/if \(handled\) s\.started = true;/.test(body), 'a handled key is what starts it');
  // The canvas is transparent so the panel's backdrop shows through, as on
  // every other panel.
  assert.ok(/g\.clearRect\(0, 0, w, h\)/.test(body), 'the canvas is cleared, not painted opaque');
  assert.ok(!/bg-black\/40/.test(body.split('<canvas')[0].split('data-swallows-keys')[1] ?? ''), 'the play area has no opaque background');
  assert.ok(/id: 'g2048'/.test(body) && /label: '2048'/.test(body), '2048 is the last game');
  const reg = src('../src/panels/registry.tsx');
  assert.ok(/id: 'games'/.test(reg) && /Body: GamesBody/.test(reg), 'the panel is registered');
  ok('wired: keys stay in the panel, nothing moves before the first key, the backdrop shows through');
}

console.log(`\ngames: ${passed}/${passed} passed`);
