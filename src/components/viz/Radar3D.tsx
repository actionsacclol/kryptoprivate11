// The Scrying Orb — the app's signature element. A turning celestial sphere
// with an inner counter-rotating gyroscope, a breathing violet halo, tilted
// constellation orbits carrying runes and comets, and faint constellation
// lines drawn between the newest sparks. Every real Pump.fun launch appears
// as a spark on the surface; entries detonate a gold shockwave and persist,
// rejections flash a crimson one and dissolve. Hovering a spark divines the
// token behind it; clicking opens the inspection drawer.
//
// Engineering notes: one WebGL context, capped DPR, additive blending so
// faded particles cost nothing visually, full disposal on unmount. Picking
// uses a per-frame draw-index → particle map so the raycaster hit indices
// stay valid even as faded particles are compacted out of the buffer.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LaunchRow } from '@shared/types';
import { makeGlowTexture, makeRuneTexture } from './arcaneTextures';
import { cls, fmtAgo } from '../../utils/format';

const MAX_PARTICLES = 240;
const MAX_CONST_LINKS = 11; // constellation joins up to 12 sparks

interface Particle {
  dir: THREE.Vector3;
  bornAt: number;
  color: THREE.Color;
  persistent: boolean;
  rejected: boolean;
  mint: string;
  pos: THREE.Vector3;
}

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  bornAt: number;
  live: boolean;
}

const COLOR_NEW = new THREE.Color('#B7A6FF');
const COLOR_ENTERED = new THREE.Color('#D9B45B');
const COLOR_REJECTED = new THREE.Color('#61141f');

/** First sight of a launch: a flagged runner keeps its gold, as an opt-in
 *  paper entry does; everything else is a fresh violet spark. */
function firstSightPhase(phase: LaunchRow['phase']): 'new' | 'entered' {
  return phase === 'entered' || phase === 'flagged' ? 'entered' : 'new';
}

export function Radar3D({
  launches,
  live,
  onSelect,
}: {
  launches: LaunchRow[];
  live: boolean;
  onSelect?: (mint: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef<Map<string, LaunchRow['phase']>>(new Map());
  const spawnRef = useRef<(phase: 'new' | 'entered' | 'rejected', mint: string) => void>(() => {});
  const pickRef = useRef<(clientX: number, clientY: number) => string | null>(() => null);
  const launchesRef = useRef<Map<string, LaunchRow>>(new Map());
  const [hover, setHover] = useState<{ mint: string; x: number; y: number } | null>(null);
  const hoverMintRef = useRef<string | null>(null);

  // Scene lifecycle — created once per mount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    // The context is created two frames after mount: the dashboard's cards and
    // numbers paint first, and a visit that leaves within those frames never
    // pays for a WebGL context it will not show.
    let teardown: (() => void) | null = null;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        teardown = buildScene(mount);
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      teardown?.();
    };
  }, []);

  // The whole scene, built once per mount; returns its own teardown.
  function buildScene(mount: HTMLDivElement): () => void {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0.6, 5.4);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => { disposables.push(x); return x; };

    const glowTex = track(makeGlowTexture());

    // Celestial sphere — deep-indigo wireframe.
    const globeGeo = track(new THREE.IcosahedronGeometry(1.9, 2));
    const globeMat = track(new THREE.MeshBasicMaterial({
      color: 0x3d4a7e,
      wireframe: true,
      transparent: true,
      opacity: 0.18,
    }));
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    // Inner gyroscope — a smaller cage counter-rotating inside the sphere.
    const gyroGeo = track(new THREE.IcosahedronGeometry(1.15, 1));
    const gyroMat = track(new THREE.MeshBasicMaterial({
      color: 0x8b7ce8,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
    }));
    const gyro = new THREE.Mesh(gyroGeo, gyroMat);
    scene.add(gyro);

    // Inner core — the orb's violet heart, with a breathing halo.
    const coreGeo = track(new THREE.SphereGeometry(0.5, 24, 24));
    const coreMat = track(new THREE.MeshBasicMaterial({ color: 0x8b7ce8, transparent: true, opacity: 0.4 }));
    const core = new THREE.Mesh(coreGeo, coreMat);
    scene.add(core);

    const haloMat = track(new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x8b7ce8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(2.1);
    scene.add(halo);

    // Constellation orbit rings — tilted great circles, each carrying runes
    // and a comet that runs the orbit.
    const ringGroup = new THREE.Group();
    interface Rider { sprite: THREE.Sprite; angle: number; speed: number; radius: number; comet: boolean }
    const riders: Rider[] = [];
    const ringHolders: THREE.Object3D[] = [];
    const RUNES = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᛟ', 'ᛞ', 'ᛉ', 'ᚱ', 'ᛗ'];
    const RING_SPECS = [
      { r: 2.45, tilt: 0.45, color: 0x3d4a7e, opacity: 0.4, spin: 0.00012 },
      { r: 2.75, tilt: -0.7, color: 0x8b7ce8, opacity: 0.22, spin: -0.00009 },
      { r: 3.05, tilt: 1.1, color: 0xd9b45b, opacity: 0.14, spin: 0.00007 },
    ];
    let runeIdx = 0;
    for (const spec of RING_SPECS) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * spec.r, 0, Math.sin(a) * spec.r));
      }
      const geo = track(new THREE.BufferGeometry().setFromPoints(pts));
      const mat = track(new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: spec.opacity }));
      const holder = new THREE.Object3D();
      holder.rotation.x = spec.tilt;
      holder.add(new THREE.Line(geo, mat));

      // Three runes ride each orbit.
      for (let k = 0; k < 3; k++) {
        const runeTex = track(makeRuneTexture(RUNES[runeIdx++ % RUNES.length]));
        const rm = track(new THREE.SpriteMaterial({
          map: runeTex,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }));
        const s = new THREE.Sprite(rm);
        s.scale.setScalar(0.28);
        holder.add(s);
        riders.push({ sprite: s, angle: (k / 3) * Math.PI * 2, speed: 0.00025, radius: spec.r, comet: false });
      }
      // One comet per orbit — a bright fast-moving spark.
      const cm = track(new THREE.SpriteMaterial({
        map: glowTex,
        color: spec.color === 0xd9b45b ? 0xd9b45b : 0xb7a6ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      const comet = new THREE.Sprite(cm);
      comet.scale.setScalar(0.16);
      holder.add(comet);
      riders.push({ sprite: comet, angle: Math.random() * Math.PI * 2, speed: 0.0011, radius: spec.r, comet: true });

      ringGroup.add(holder);
      ringHolders.push(holder);
    }
    scene.add(ringGroup);

    // Ambient starfield — pale parchment dust.
    const starCount = 350;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 8);
      starPos.set([v.x, v.y, v.z], i * 3);
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = track(new THREE.PointsMaterial({ color: 0xd8d4c6, size: 0.03, transparent: true, opacity: 0.55 }));
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // Launch particles — dynamic buffer, additive blending (fade = darken).
    const particles: Particle[] = [];
    const drawMap: Particle[] = []; // draw index → particle, rebuilt each frame
    const pPos = new Float32Array(MAX_PARTICLES * 3);
    const pCol = new Float32Array(MAX_PARTICLES * 3);
    const pGeo = track(new THREE.BufferGeometry());
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    const pMat = track(new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    const points = new THREE.Points(pGeo, pMat);
    // The lazy bounding sphere would be computed from the zeroed buffer on
    // frame 1 (radius 0) and never invalidated — killing raycast picking for
    // the component's lifetime. Pin a sphere that covers the particle shell.
    pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.6);
    points.frustumCulled = false;
    scene.add(points);

    // Constellation lines — faint links between the newest living sparks.
    const cPos = new Float32Array(MAX_CONST_LINKS * 2 * 3);
    const cGeo = track(new THREE.BufferGeometry());
    cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
    const cMat = track(new THREE.LineBasicMaterial({
      color: 0x8b7ce8,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const constLines = new THREE.LineSegments(cGeo, cMat);
    constLines.frustumCulled = false;
    scene.add(constLines);

    // Shockwave pool — gold for entries, crimson for banishments.
    const waves: Shockwave[] = [];
    for (let i = 0; i < 6; i++) {
      const geo = track(new THREE.RingGeometry(0.92, 1.0, 48));
      const mat = track(new THREE.MeshBasicMaterial({
        color: 0xd9b45b,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      waves.push({ mesh, mat, bornAt: 0, live: false });
    }
    const fireWave = (dir: THREE.Vector3, color: number): void => {
      const w = waves.find((x) => !x.live) ?? waves[0];
      w.live = true;
      w.bornAt = performance.now();
      w.mat.color.setHex(color);
      w.mesh.position.copy(dir).multiplyScalar(2.0);
      w.mesh.visible = true;
    };

    spawnRef.current = (phase, mint) => {
      const dir = new THREE.Vector3().randomDirection();
      const color =
        phase === 'entered' ? COLOR_ENTERED.clone() : phase === 'rejected' ? COLOR_REJECTED.clone() : COLOR_NEW.clone();
      particles.push({
        dir,
        bornAt: performance.now(),
        color,
        persistent: phase === 'entered',
        rejected: phase === 'rejected',
        mint,
        pos: new THREE.Vector3(),
      });
      if (particles.length > MAX_PARTICLES) particles.shift();
      if (phase === 'entered') fireWave(dir, 0xd9b45b);
      else if (phase === 'rejected') fireWave(dir, 0xe5484d);
    };

    // Divination picking — raycast against the compacted particle buffer.
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.16 };
    const ndc = new THREE.Vector2();
    pickRef.current = (clientX, clientY) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(points);
      for (const hit of hits) {
        const p = hit.index != null ? drawMap[hit.index] : undefined;
        if (p) return p.mint;
      }
      return null;
    };

    const resize = (): void => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      // Let three set canvas CSS size too — otherwise the canvas lays out at
      // backing-store size and overflows the mount at Windows scaling > 100%.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    let lastNow = 0;
    const tmpColor = new THREE.Color();
    const render = (now: number): void => {
      // Clamped: after a stall or a backgrounded window the gap can be
      // seconds, and feeding that in would fling every orbiting ring across
      // the scene on the first frame back.
      const dt = lastNow ? Math.min(now - lastNow, 100) : 16;
      lastNow = now;

      // The machine turns: sphere one way, gyroscope the other, orbits drift.
      globe.rotation.y = now * 0.00028;
      globe.rotation.x = Math.sin(now * 0.00006) * 0.2;
      gyro.rotation.y = -now * 0.00045;
      gyro.rotation.z = now * 0.00019;
      stars.rotation.y = now * 0.00002;
      ringGroup.rotation.y = -now * 0.00016;
      ringHolders.forEach((h, i) => {
        h.rotation.z = Math.sin(now * 0.00005 + i * 2.1) * 0.12; // slow precession wobble
      });

      // Breathing core + halo.
      const breath = 1 + Math.sin(now * 0.0016) * 0.12;
      core.scale.setScalar(breath);
      halo.scale.setScalar(2.1 * breath);
      haloMat.opacity = 0.4 + Math.sin(now * 0.0016) * 0.15;

      // Camera drifts like an observer circling the instrument.
      camera.position.x = Math.sin(now * 0.00011) * 0.55;
      camera.position.y = 0.6 + Math.sin(now * 0.00007) * 0.22;
      camera.lookAt(0, 0, 0);

      // Runes and comets ride their orbits.
      for (const r of riders) {
        r.angle += r.speed * dt;
        r.sprite.position.set(Math.cos(r.angle) * r.radius, 0, Math.sin(r.angle) * r.radius);
        if (!r.comet) {
          const m = r.sprite.material as THREE.SpriteMaterial;
          m.opacity = 0.35 + Math.sin(now * 0.001 + r.angle * 3) * 0.2;
        }
      }

      // Shockwaves bloom and fade.
      for (const w of waves) {
        if (!w.live) continue;
        const t = (now - w.bornAt) / 900;
        if (t >= 1) { w.live = false; w.mesh.visible = false; continue; }
        w.mesh.scale.setScalar(0.15 + t * 1.1);
        w.mat.opacity = 0.85 * (1 - t);
        w.mesh.quaternion.copy(camera.quaternion);
      }

      let n = 0;
      drawMap.length = 0;
      for (const p of particles) {
        const age = (now - p.bornAt) / 1000;
        const burst = Math.min(1, age * 5); // fly out over 200ms
        const r = 1.9 + burst * 0.45 + (p.persistent ? Math.sin(now * 0.004 + p.bornAt) * 0.06 : 0);
        const fade = p.persistent ? 0.75 + Math.sin(now * 0.005 + p.bornAt) * 0.25 : Math.max(0, 1 - age / 6);
        if (fade <= 0.01) continue;
        p.pos.copy(p.dir).multiplyScalar(r);
        pPos.set([p.pos.x, p.pos.y, p.pos.z], n * 3);
        tmpColor.copy(p.color).multiplyScalar(fade);
        pCol.set([tmpColor.r, tmpColor.g, tmpColor.b], n * 3);
        drawMap[n] = p;
        n++;
      }
      pGeo.setDrawRange(0, n);
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;

      // Constellation: chain the newest living, non-rejected sparks.
      const alive = drawMap.filter((p) => p && !p.rejected).slice(-(MAX_CONST_LINKS + 1));
      let seg = 0;
      for (let i = 0; i + 1 < alive.length; i++) {
        cPos.set([alive[i].pos.x, alive[i].pos.y, alive[i].pos.z], seg * 6);
        cPos.set([alive[i + 1].pos.x, alive[i + 1].pos.y, alive[i + 1].pos.z], seg * 6 + 3);
        seg++;
      }
      cGeo.setDrawRange(0, seg * 2);
      cGeo.attributes.position.needsUpdate = true;
      cMat.opacity = 0.18 + Math.sin(now * 0.0012) * 0.1;

      renderer.render(scene, camera);
    };

    // ── Frame cap ────────────────────────────────────────────────────
    //
    // This scene is decoration, not instrumentation: nobody reads a value off
    // it, and at 144Hz it was asking the GPU for four times the work of a
    // 30fps render to look identical. Capping frees the compositor for the
    // parts of the app that ARE data — a chart, a scrolling column of cards.
    //
    // The cap is enforced by SKIPPING renders, not by slowing the clock:
    // requestAnimationFrame still drives the loop, so motion stays smooth and
    // in step with real time rather than juddering to a schedule.
    const MIN_FRAME_MS = 1000 / 30;
    let lastFrameAt = 0;

    // The orb always turns — it is the instrument's heartbeat. (Windows'
    // "show animations" toggle maps to prefers-reduced-motion in Chromium
    // and would otherwise freeze the signature element on gamer rigs.)
    const loop = (now: number): void => {
      if (now - lastFrameAt >= MIN_FRAME_MS) {
        lastFrameAt = now;
        render(now);
      }
      raf = requestAnimationFrame(loop);
    };

    // A fresh scene starts with zero particles, and the launches-diff effect
    // has already run against the no-op spawn (the scene is built after it):
    // replay what it recorded, so the first frame is not an empty orb.
    // StrictMode double-mount, Fast Refresh and route remounts hit this too.
    seenRef.current.clear();
    for (const l of launchesRef.current.values()) {
      seenRef.current.set(l.mint, l.phase);
      spawnRef.current(firstSightPhase(l.phase), l.mint);
    }

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      // Release the WebGL context now — route remounts would otherwise pile
      // up contexts until GC gets around to them.
      renderer.forceContextLoss();
      for (const d of disposables) d.dispose();
      mount.removeChild(renderer.domElement);
    };
  }

  // Diff incoming launches → spawn particles for new mints & phase changes.
  useEffect(() => {
    const byMint = launchesRef.current;
    byMint.clear();
    for (const l of launches) byMint.set(l.mint, l);

    const seen = seenRef.current;
    for (const l of launches) {
      const prev = seen.get(l.mint);
      if (prev === undefined) {
        seen.set(l.mint, l.phase);
        // First sight (or scene respawn): a flagged runner keeps its gold,
        // as an opt-in paper entry does.
        spawnRef.current(firstSightPhase(l.phase), l.mint);
      } else if (prev !== l.phase) {
        seen.set(l.mint, l.phase);
        if (l.phase === 'entered' || l.phase === 'flagged') spawnRef.current('entered', l.mint);
        else if (l.phase === 'rejected') spawnRef.current('rejected', l.mint);
      }
    }
    if (seen.size > 600) {
      const keep = new Set(launches.map((l) => l.mint));
      for (const k of seen.keys()) if (!keep.has(k)) seen.delete(k);
    }
  }, [launches]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const picked = pickRef.current(e.clientX, e.clientY);
    // A persistent gold spark can outlive its evicted launch row — without
    // data it must not offer a cursor, tooltip, or dead click.
    const mint = picked && launchesRef.current.has(picked) ? picked : null;
    const rect = mountRef.current?.getBoundingClientRect();
    if (mint && rect) {
      hoverMintRef.current = mint;
      setHover({ mint, x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else if (hoverMintRef.current) {
      hoverMintRef.current = null;
      setHover(null);
    }
  };

  const hovered = hover ? launchesRef.current.get(hover.mint) : undefined;

  return (
    <div
      className={cls('relative h-full w-full', hover && 'cursor-pointer')}
      ref={mountRef}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { hoverMintRef.current = null; setHover(null); }}
      onClick={() => { if (hover && onSelect) onSelect(hover.mint); }}
    >
      {hover && hovered && (
        <div
          className="pointer-events-none absolute z-20 w-52 rounded-md border border-krypt-purple/30 bg-black/90 px-3 py-2.5 font-mono text-[11px] leading-relaxed backdrop-blur-sm shadow-krypt-glow"
          style={{
            left: Math.min(hover.x + 14, (mountRef.current?.clientWidth ?? 300) - 216),
            top: Math.max(8, hover.y - 12),
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold text-white">{hovered.symbol || '—'}</span>
            <span className={cls(
              'text-[10px] uppercase tracking-wider',
              hovered.phase === 'entered' ? 'text-arc-gold' : hovered.phase === 'rejected' ? 'text-rose-300' : 'text-krypt-pink',
            )}>{hovered.phase}</span>
          </div>
          <div className="mt-1 text-krypt-muted space-y-0.5">
            <div>age {fmtAgo(hovered.detectedAt)} · score {hovered.score ? hovered.score.total : '—'}</div>
            <div>
              net{' '}
              <span className={hovered.flow.netInflowSol >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {hovered.flow.netInflowSol.toFixed(2)} SOL
              </span>{' '}
              · {hovered.flow.uniqueBuyers} buyers
            </div>
            <div>curve {hovered.flow.curveProgressPct.toFixed(1)}%</div>
            {hovered.reason && <div className="text-rose-300/85 truncate">{hovered.reason}</div>}
          </div>
          <div className="mt-1 text-[9px] text-krypt-muted/60">click to divine</div>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-4 font-mono text-[9px] uppercase tracking-[0.28em] text-krypt-muted/50">
        {live ? 'live · mainnet' : 'offline'}
      </div>
    </div>
  );
}
