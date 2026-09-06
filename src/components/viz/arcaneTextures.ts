// Shared canvas-texture helpers for the arcane three.js scenes (the scrying
// orb, the wallet tome). Each returns a CanvasTexture the caller must
// dispose.

import * as THREE from 'three';

/** Soft radial glow sprite texture (halos, comets, sparkles). */
export function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A single rune drawn to a sprite texture. Segoe UI Symbol covers the
 *  Runic block on Windows 10+. */
export function makeRuneTexture(rune: string, color = '#cfc7ff', shadow = '#8B7CE8'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '44px "Segoe UI Symbol", "Segoe UI Historic", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.shadowColor = shadow;
  ctx.shadowBlur = 10;
  ctx.fillText(rune, 32, 34);
  return new THREE.CanvasTexture(c);
}
