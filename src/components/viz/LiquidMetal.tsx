// Liquid metal — the app's backdrop.
//
// A slow sheet of poured chrome under the workspace cards, tinted to the
// observatory palette (arcane violet, ritual gold, obsidian void) rather
// than the silver-grey the effect usually comes in. It is decoration and
// nothing else: it reads no state, it is never interactive, and it is the
// first thing to go when the machine cannot take it.
//
// ── Why this is hand-written and not a library ────────────────────────
//
// The reference build stacks `@paper-design/shaders-react` on top of
// framer-motion. `three` is already a dependency here (Tome3D, Radar3D), so
// the shader below costs no new package, no second WebGL abstraction, and
// nothing extra in the installer — which matters when the bundle is already
// watched for hashed-chunk bloat and the main process ships as V8 bytecode.
//
// ── The rules this obeys, all of them load-bearing ────────────────────
//
// 1. NEVER mount while `reduceEffects` is unknown. A WebGL context that
//    exists for the 50 ms before the setting is read has already touched the
//    graphics driver, and a bad driver is how a user got a BSOD on
//    2026-09-08. `useReduceEffects()` returns null until it knows; null is
//    treated as "off", exactly like the other scenes.
// 2. The context is created two frames after mount, so a Hub that is passed
//    through on the way somewhere else never pays for it.
// 3. Half resolution and 30 fps. This is a soft, slow field behind opaque
//    cards; at native resolution and 60 fps it would be the most expensive
//    thing on a screen whose whole job is to sit still and be looked at.
//    Halving each axis is a quarter of the pixels and is not visible.
// 4. Paused while the window is hidden. The app gets left open for hours
//    behind other windows, and a backdrop must cost nothing while nobody is
//    looking at it.
// 6. ONE context for the life of the app. Navigation changes a uniform, not
//    the scene — building a WebGL context per route would make navigation
//    the expensive thing, which is the opposite of the point.
// 5. Everything disposed on unmount, and a lost context tears down rather
//    than leaving a dead canvas lit.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useReduceEffects } from './useReduceEffects';

// The backdrop is now on EVERY page, so its cost is paid all the time and
// the quiet variant has to be cheap enough to sit behind the chart and
// Discover without being felt. Two dials do that, and both are coarse on
// purpose: fewer pixels and fewer frames beat a cleverer shader.
//
// Full (the Hub, the moment of arrival): half resolution, 30 fps.
// Quiet (everywhere else): a third of each axis — a NINTH of the pixels —
// and 15 fps. At the opacity the quiet variant runs at, neither is visible
// as a difference; together they are roughly an 18x cut in shader work.
const RENDER_SCALE_FULL = 0.5;
const RENDER_SCALE_QUIET = 0.34;
const TARGET_FPS_FULL = 30;
const TARGET_FPS_QUIET = 15;
/** Even on a 3x display this is a decorative field; 1.5 is plenty. */
const MAX_DPR = 1.5;

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Domain-warped fbm lit as a metal surface. The warp is what turns noise
// into something that looks poured; the sharp specular lobes are what make
// it read as metal rather than fog.
const FRAG = `
  precision highp float;

  uniform vec2  uRes;
  uniform float uTime;
  /** 1 = the Hub's full-strength sheet; below that, everywhere else. */
  uniform float uIntensity;
  varying vec2  vUv;

  const vec3 VOID_C   = vec3(0.024, 0.027, 0.059); // #06070F
  const vec3 VIOLET_C = vec3(0.545, 0.486, 0.910); // #8B7CE8
  const vec3 PINK_C   = vec3(0.718, 0.651, 1.000); // #B7A6FF
  const vec3 GOLD_C   = vec3(0.851, 0.706, 0.357); // #D9B45B

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Four octaves. A fifth is invisible once the field is this soft and
  // costs a fifth of the shader.
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = rot * p * 2.03;
      a *= 0.5;
    }
    return v;
  }

  // One warp level, two fbm lookups deep. Two levels look marginally better
  // and cost nearly double; at this scale and opacity nobody can tell.
  float height(vec2 p, float t) {
    vec2 q = vec2(
      fbm(p + vec2(0.0, t * 0.055)),
      fbm(p + vec2(5.2, 1.3) - vec2(t * 0.042, 0.0))
    );
    return fbm(p + 3.2 * q + vec2(1.7, 9.2));
  }

  void main() {
    // Aspect-corrected, centred, and zoomed so the features are large and
    // slow — a busy backdrop behind text is just noise.
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
    vec2 p = uv * 2.4;
    float t = uTime;

    float h = height(p, t);

    // Pseudo-normal from finite differences. The offset is tuned to the
    // field, not to the pixel grid, so it does not change with resolution.
    float e = 0.035;
    float hx = height(p + vec2(e, 0.0), t);
    float hy = height(p + vec2(0.0, e), t);
    vec3 n = normalize(vec3((h - hx) / e, (h - hy) / e, 1.6));

    vec3 view = vec3(0.0, 0.0, 1.0);
    vec3 key  = normalize(vec3(-0.55, 0.75, 0.42)); // violet, upper left
    vec3 rim  = normalize(vec3(0.70, -0.45, 0.38)); // gold, lower right

    float dKey = max(dot(n, key), 0.0);
    float dRim = max(dot(n, rim), 0.0);
    float sKey = pow(max(dot(reflect(-key, n), view), 0.0), 42.0);
    float sRim = pow(max(dot(reflect(-rim, n), view), 0.0), 96.0);
    float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);

    // The chrome banding. Running the height field through a cosine ramp is
    // what separates "liquid metal" from "purple fog"; the power sharpens
    // the bands into something that catches light.
    float bands = 0.5 + 0.5 * cos(h * 13.0 + t * 0.22);
    bands = pow(clamp(bands, 0.0, 1.0), 2.4);

    vec3 col = VOID_C;
    col += VIOLET_C * (dKey * 0.19 + sKey * 0.58);
    col += GOLD_C   * (dRim * 0.05 + sRim * 0.30);
    col += PINK_C   * bands * 0.13;
    col += PINK_C   * fres * 0.11;

    // The cards and the title live in the middle, so the middle is where the
    // field goes quiet; it earns its keep out at the edges where there is
    // nothing to read. A backdrop that competes with the text it sits behind
    // is just noise with extra steps.
    float r = length(uv);
    float centreFade = smoothstep(0.12, 1.00, r);
    float edgeFade = 1.0 - smoothstep(0.90, 1.50, r);
    float a = (0.13 + 0.62 * centreFade) * edgeFade;

    // Quiet pages pull the middle down harder than the edges: the centre is
    // where the tables, the chart and the numbers live, and a backdrop that
    // competes with a price is worse than no backdrop.
    //
    // The centre guard is switched by the Hub, NOT dialled by the intensity.
    // It used to interpolate on the intensity itself, which coupled the two
    // dials the wrong way round: turning the backdrop up brightened the CENTRE
    // faster than the edges (1.8x against 1.55x going 0.3 -> 0.45), eroding the
    // one thing the guard exists to protect. Now the guard is full on every
    // page but the Hub, and uIntensity only sets overall strength -- so the
    // dial lifts the corners and leaves the numbers alone.
    //
    // No backticks in here: this whole shader is a JS template literal, and one
    // would end the string. That is what broke the build when it was written.
    float quiet = clamp(uIntensity, 0.0, 1.0);
    a *= mix(0.35 + 0.45 * centreFade, 1.0, step(1.0, quiet));
    a *= quiet;

    gl_FragColor = vec4(col, a);
  }
`;

function build(mount: HTMLDivElement, initialIntensity: number): { dispose: () => void; setIntensity: (v: number) => void } {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false, // a full-screen quad has no edges to smooth
      powerPreference: 'low-power',
    });
  } catch {
    // No WebGL: the app is fine without this.
    return { dispose: () => undefined, setIntensity: () => undefined };
  }

  const scene = new THREE.Scene();
  // A fixed clip-space quad: the vertex shader ignores the camera entirely,
  // so this never needs a projection or a resize.
  const camera = new THREE.Camera();
  const geo = new THREE.PlaneGeometry(2, 2);
  const uniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uIntensity: { value: initialIntensity },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(geo, mat);
  quad.frustumCulled = false;
  scene.add(quad);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearAlpha(0);
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  mount.appendChild(canvas);

  // Re-read on every resize AND on every intensity change, because the
  // render scale is a function of it.
  let scale = initialIntensity >= 1 ? RENDER_SCALE_FULL : RENDER_SCALE_QUIET;
  let frameGap = 1000 / (initialIntensity >= 1 ? TARGET_FPS_FULL : TARGET_FPS_QUIET);

  const resize = (): void => {
    const w = Math.max(1, Math.floor(mount.clientWidth * scale));
    const h = Math.max(1, Math.floor(mount.clientHeight * scale));
    // `false` leaves the CSS size alone — the canvas is stretched back to
    // full size by the style above, which is the whole point of the scale.
    renderer.setSize(w, h, false);
    uniforms.uRes.value.set(w, h);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  const started = performance.now();
  let raf = 0;
  let lastDraw = 0;
  let running = true;

  const loop = (now: number): void => {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (now - lastDraw < frameGap) return;
    lastDraw = now;
    uniforms.uTime.value = (now - started) / 1000;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  // A Hub left open behind another window should cost nothing at all.
  const onVisibility = (): void => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      lastDraw = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // A context that goes away (driver reset, GPU switch) must not leave a
  // frozen canvas painted over the page.
  const onLost = (e: Event): void => {
    e.preventDefault();
    running = false;
    cancelAnimationFrame(raf);
    canvas.style.opacity = '0';
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    // Navigation changes a uniform and a render scale. It does NOT tear the
    // context down and build another: creating a WebGL context costs far
    // more than this shader ever will, and doing it on every route change
    // would make navigation the expensive thing.
    setIntensity: (v: number): void => {
      const next = Math.max(0, Math.min(1, v));
      if (uniforms.uIntensity.value === next) return;
      uniforms.uIntensity.value = next;
      const wantScale = next >= 1 ? RENDER_SCALE_FULL : RENDER_SCALE_QUIET;
      frameGap = 1000 / (next >= 1 ? TARGET_FPS_FULL : TARGET_FPS_QUIET);
      if (wantScale !== scale) {
        scale = wantScale;
        resize();
      }
    },
    dispose: (): void => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      ro.disconnect();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode === mount) mount.removeChild(canvas);
    },
  };
}

/**
 * The canvas layer itself. Mounted only by `AppBackdrop` below, which is
 * what decides whether it may exist at all.
 */
function LiquidMetal({ intensity }: { intensity: number }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ setIntensity: (v: number) => void } | null>(null);
  // Read inside the mount effect without making it a dependency: the effect
  // must run ONCE for the life of the app, and re-running it would be the
  // context churn this design exists to avoid.
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    // Two frames: the page's text paints first, and a visit that leaves
    // inside that window never creates a context.
    let built: { dispose: () => void; setIntensity: (v: number) => void } | null = null;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        built = build(mount, intensityRef.current);
        apiRef.current = built;
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      apiRef.current = null;
      built?.dispose();
    };
  }, []);

  // Navigation lands here: one uniform, one render scale, no rebuild.
  useEffect(() => {
    apiRef.current?.setIntensity(intensity);
  }, [intensity]);

  // NO z-index, deliberately — this sits with `bg-krypt-radial` and
  // `stars-backdrop` in App's backdrop layer and paints in DOM order, which
  // is what keeps it BEHIND the page.
  //
  // The first version had `z-0` and lived inside the Hub. That was wrong
  // twice over: `z-0` promotes the canvas into the positioned layer, and the
  // top bar is a plain static `<div>` with no z-index of its own, so a
  // half-transparent sheet of chrome painted straight over it and washed it
  // out. A backdrop must be a sibling of the other backdrops, not a child of
  // the content it is meant to sit behind.
  return <div ref={mountRef} aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden" />;
}

/** Full strength on the Hub; a ninth of the pixels and half the frames
 *  everywhere else. See RENDER_SCALE_QUIET for why both dials move.
 *
 *  The quiet value is alpha ONLY — resolution and frame rate switch on
 *  `>= 1`, so raising it costs nothing. 0.45 against the old 0.3 lifts the
 *  corners about 1.4x and leaves the centre where it was, which is the
 *  point of the guard in the shader. */
export const BACKDROP_FULL = 1;
export const BACKDROP_QUIET = 0.45;

/**
 * The app's backdrop, gated.
 *
 * Rendered by App next to the other full-viewport backdrops, ONCE, for the
 * life of the app — `intensity` is what changes on navigation, not whether
 * this exists. Nothing mounts until `reduceEffects` is KNOWN to be false: it
 * answers null while it is still reading, and a scene must never mount on a
 * maybe — a WebGL context that exists for the 50 ms before the answer
 * arrives has already touched the graphics driver.
 *
 * Turning on Lite mode (Settings › Display, or the Hub's "Laggy?" button)
 * flips this to true through the lite store, so the component unmounts and
 * its effect cleanup disposes the context. No reload, nothing left running.
 */
export function AppBackdrop({ intensity }: { intensity: number }): JSX.Element | null {
  const reduceEffects = useReduceEffects();
  if (reduceEffects !== false) return null;
  return <LiquidMetal intensity={intensity} />;
}
