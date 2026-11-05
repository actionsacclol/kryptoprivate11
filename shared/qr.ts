// A QR code encoder: byte mode, error correction level M, versions 1 to 10.
// Written here for one job, so an authenticator app can scan a setup code,
// without adding a dependency to a program that holds keys. Up to 213 bytes,
// comfortably more than an otpauth:// link needs. Pure.
//
// Follows ISO/IEC 18004. Checked in test/totp.test.mjs against an independent
// decoder (scanned by jsQR when the test was written) and pinned to that output.

const EC_CODEWORDS_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_EC_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function totalDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    n -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const totalCodewords = (ver: number): number => Math.floor(totalDataModules(ver) / 8);
const dataCodewords = (ver: number): number => totalCodewords(ver) - EC_CODEWORDS_PER_BLOCK[ver - 1] * NUM_EC_BLOCKS[ver - 1];
const lengthBits = (ver: number): number => (ver < 10 ? 8 : 16);

export const QR_MAX_BYTES = dataCodewords(10) - 3;

// ── Reed-Solomon over GF(256) ──────────────────────────────────────────

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

function withErrorCorrection(data: number[], ver: number): number[] {
  const numBlocks = NUM_EC_BLOCKS[ver - 1];
  const ecLen = EC_CODEWORDS_PER_BLOCK[ver - 1];
  const raw = totalCodewords(ver);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  const divisor = rsDivisor(ecLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - ecLen + (i < numShort ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }
  const out: number[] = [];
  const longest = shortLen - ecLen + 1;
  for (let i = 0; i < longest; i++) {
    blocks.forEach((b, j) => {
      // Short blocks have no byte at the last index.
      if (i !== longest - 1 || j >= numShort) out.push(b[i]);
    });
  }
  for (let i = 0; i < ecLen; i++) for (const e of ecBlocks) out.push(e[i]);
  return out;
}

// ── The grid ───────────────────────────────────────────────────────────

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.ver === 1) return [];
    const numAlign = Math.floor(this.ver / 7) + 2;
    const step = Math.floor((this.ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const align = this.alignmentPositions();
    const n = align.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0);
    if (this.ver >= 7) {
      let rem = this.ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  drawFormat(mask: number): void {
    // Level M is format bits 00.
    const data = mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true);
  }

  drawCodewords(all: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.fixed[y][x] && i < all.length * 8) {
            this.dark[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.fixed[y][x] && invert) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }

  penalty(): number {
    let score = 0;
    const s = this.size;
    const line = (at: (i: number) => boolean): void => {
      let run = 1;
      for (let i = 1; i < s; i++) {
        if (at(i) === at(i - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
      for (let i = 0; i + 10 < s; i++) {
        const pattern = [true, false, true, true, true, false, true, false, false, false, false];
        if (pattern.every((v, k) => at(i + k) === v) || pattern.every((v, k) => at(i + 10 - k) === v)) score += 40;
      }
    };
    for (let y = 0; y < s; y++) line((i) => this.dark[y][i]);
    for (let x = 0; x < s; x++) line((i) => this.dark[i][x]);
    let darkCount = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        if (this.dark[y][x]) darkCount++;
        if (x + 1 < s && y + 1 < s) {
          const c = this.dark[y][x];
          if (c === this.dark[y][x + 1] && c === this.dark[y + 1][x] && c === this.dark[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = s * s;
    score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** The modules, rows of booleans (true = dark), or throws when too long. */
export function qrEncode(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 10; ver++) {
    if (4 + lengthBits(ver) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 10) throw new Error('too long for this QR encoder');

  const bits: number[] = [];
  const push = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits(ver));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  const grid = new Grid(ver);
  grid.drawCodewords(withErrorCorrection(data, ver));
  let bestMask = 0;
  let best = Infinity;
  for (let m = 0; m < 8; m++) {
    grid.applyMask(m);
    grid.drawFormat(m);
    const p = grid.penalty();
    if (p < best) {
      best = p;
      bestMask = m;
    }
    grid.applyMask(m);
  }
  grid.applyMask(bestMask);
  grid.drawFormat(bestMask);
  return grid.dark;
}
