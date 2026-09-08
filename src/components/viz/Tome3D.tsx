// The Vault Tome — the Wallet page's centerpiece. A gilded spellbook floats
// half-open in the void, slowly turning: violet-leather covers rimmed in
// gold, parchment page blocks, a rune burning above the spine, six runes
// orbiting the whole book, and two streams of rising sparkle-dust (violet
// and gold). Lit by a violet key light and a gold under-light so the covers
// actually shade as it spins.
//
// Engineering: one WebGL context, capped DPR, everything disposed on
// unmount, rAF loop always runs (the tome is the page's heartbeat).

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { makeGlowTexture, makeRuneTexture } from './arcaneTextures';

const SPARKS = 46;
const GOLD_SPARKS = 22;

function makeSparkField(
  count: number,
  color: number,
  size: number,
  glowTex: THREE.Texture,
): { points: THREE.Points; geo: THREE.BufferGeometry; mat: THREE.PointsMaterial; speeds: Float32Array } {
  const pos = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 3.4;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 3.6;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
    speeds[i] = 0.0015 + Math.random() * 0.003;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    map: glowTex,
    color,
    size,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // dust wraps constantly; skip stale-sphere culling
  return { points, geo, mat, speeds };
}

export function Tome3D() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    // The context is created two frames after mount: the page's text paints first,
    // and a visit that leaves within those frames never pays for a WebGL
    // context it will not show.
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
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
    camera.position.set(0, 0.35, 4.6);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => { disposables.push(x); return x; };
    const glowTex = track(makeGlowTexture());

    // Lighting — violet key, gold under-light, faint ambient.
    scene.add(new THREE.AmbientLight(0x9a94c2, 0.85));
    const keyLight = new THREE.PointLight(0x8b7ce8, 30, 30);
    keyLight.position.set(2.2, 2.4, 3.2);
    scene.add(keyLight);
    const goldLight = new THREE.PointLight(0xd9b45b, 16, 30);
    goldLight.position.set(-2, -1.6, 2.4);
    scene.add(goldLight);
    // Rim light from behind so the silhouette stays readable mid-spin.
    const rimLight = new THREE.PointLight(0xb7a6ff, 18, 30);
    rimLight.position.set(0, 1.2, -3.4);
    scene.add(rimLight);

    // ── The tome ─────────────────────────────────────────────────────
    const tome = new THREE.Group();
    scene.add(tome);

    const leather = track(new THREE.MeshStandardMaterial({
      color: 0x342a6b, roughness: 0.5, metalness: 0.3, emissive: 0x16112f, emissiveIntensity: 1,
    }));
    const gold = track(new THREE.MeshStandardMaterial({ color: 0xd9b45b, roughness: 0.3, metalness: 0.85 }));
    const parchment = track(new THREE.MeshStandardMaterial({ color: 0xe8e4d6, roughness: 0.9, metalness: 0.02 }));

    const coverGeo = track(new THREE.BoxGeometry(1.5, 2.0, 0.08));
    // Trim is WIDER but SHALLOWER than the cover and shares its center, so it
    // reads as a gilded rim from every angle instead of a gold plate that
    // swallows the whole cover when the book shows its back mid-spin.
    const trimGeo = track(new THREE.BoxGeometry(1.6, 2.1, 0.03));
    const pageGeo = track(new THREE.BoxGeometry(1.36, 1.86, 0.11));
    const spineGeo = track(new THREE.BoxGeometry(0.16, 2.1, 0.18));

    // Each side hangs off a hinge at the spine so the book sits half-open.
    const makeSide = (dir: 1 | -1): THREE.Object3D => {
      const hinge = new THREE.Object3D();
      const cover = new THREE.Mesh(coverGeo, leather);
      cover.position.set(dir * 0.79, 0, 0);
      const trim = new THREE.Mesh(trimGeo, gold);
      trim.position.set(dir * 0.79, 0, 0);
      const pages = new THREE.Mesh(pageGeo, parchment);
      pages.position.set(dir * 0.72, 0, 0.09);
      hinge.add(trim, cover, pages);
      hinge.rotation.y = -dir * 0.48; // half-open V
      return hinge;
    };
    tome.add(makeSide(1), makeSide(-1));
    const spine = new THREE.Mesh(spineGeo, gold);
    spine.position.z = -0.02;
    tome.add(spine);

    // The rune burning above the open pages.
    const sigilTex = track(makeRuneTexture('ᛟ', '#ffe9b8', '#d9b45b'));
    const sigilMat = track(new THREE.SpriteMaterial({
      map: sigilTex, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const sigil = new THREE.Sprite(sigilMat);
    sigil.scale.setScalar(0.6);
    sigil.position.set(0, 0.55, 0.5);
    tome.add(sigil);

    // Sigil halo.
    const haloMat = track(new THREE.SpriteMaterial({
      map: glowTex, color: 0x8b7ce8, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(3.4);
    halo.position.z = -0.4;
    scene.add(halo);

    // ── Orbiting runes ───────────────────────────────────────────────
    const RUNES = ['ᚠ', 'ᚱ', 'ᛗ', 'ᛞ', 'ᚨ', 'ᛉ'];
    interface Orbiter { sprite: THREE.Sprite; angle: number; speed: number; r: number; y: number }
    const orbiters: Orbiter[] = [];
    for (let i = 0; i < RUNES.length; i++) {
      const tex = track(makeRuneTexture(RUNES[i]));
      const mat = track(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const s = new THREE.Sprite(mat);
      s.scale.setScalar(0.3);
      scene.add(s);
      orbiters.push({
        sprite: s,
        angle: (i / RUNES.length) * Math.PI * 2,
        speed: 0.00045,
        r: 2.0,
        y: Math.sin((i / RUNES.length) * Math.PI * 2) * 0.5,
      });
    }

    // ── Rising sparkle dust ──────────────────────────────────────────
    const violetDust = makeSparkField(SPARKS, 0xb7a6ff, 0.09, glowTex);
    track(violetDust.geo); track(violetDust.mat);
    scene.add(violetDust.points);
    const goldDust = makeSparkField(GOLD_SPARKS, 0xd9b45b, 0.07, glowTex);
    track(goldDust.geo); track(goldDust.mat);
    scene.add(goldDust.points);

    const resize = (): void => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    // Frame-COUNTED motion, so it must be scaled by the real elapsed time.
    // The hardcoded 16 assumed every frame was 1/60s; once frames are capped
    // (or the machine is busy) that assumption silently halves the speed.
    const animateDust = (field: typeof violetDust, deltaMs: number): void => {
      const arr = field.geo.attributes.position.array as Float32Array;
      for (let i = 0; i < field.speeds.length; i++) {
        arr[i * 3 + 1] += field.speeds[i] * deltaMs;
        if (arr[i * 3 + 1] > 1.9) {
          arr[i * 3 + 1] = -1.9;
          arr[i * 3] = (Math.random() - 0.5) * 3.4;
          arr[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
        }
      }
      field.geo.attributes.position.needsUpdate = true;
    };

    const render = (now: number, deltaMs: number): void => {
      // The tome turns and levitates, tipped toward the observer so the open
      // pages stay readable through the whole spin.
      tome.rotation.y = now * 0.0005;
      tome.position.y = Math.sin(now * 0.0011) * 0.14;
      tome.rotation.z = Math.sin(now * 0.0007) * 0.05;
      tome.rotation.x = 0.42 + Math.sin(now * 0.0004) * 0.06;

      // Sigil burns and breathes.
      sigilMat.opacity = 0.7 + Math.sin(now * 0.003) * 0.25;
      sigil.position.y = 0.35 + Math.sin(now * 0.0016) * 0.06;
      haloMat.opacity = 0.38 + Math.sin(now * 0.0014) * 0.14;
      halo.scale.setScalar(3.4 + Math.sin(now * 0.0014) * 0.3);

      // Runes circle the book.
      for (const o of orbiters) {
        o.angle += o.speed * deltaMs;
        o.sprite.position.set(Math.cos(o.angle) * o.r, o.y + Math.sin(now * 0.001 + o.angle) * 0.12, Math.sin(o.angle) * o.r);
        (o.sprite.material as THREE.SpriteMaterial).opacity = 0.35 + Math.sin(now * 0.0012 + o.angle * 2) * 0.22;
      }

      animateDust(violetDust, deltaMs);
      animateDust(goldDust, deltaMs);

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

    const loop = (now: number): void => {
      if (now - lastFrameAt >= MIN_FRAME_MS) {
        // Clamped: after a tab is backgrounded or the machine stalls, the gap
        // can be seconds, and feeding that straight in would teleport every
        // orbiter across the scene on the first frame back.
        const deltaMs = lastFrameAt ? Math.min(now - lastFrameAt, 100) : 16;
        lastFrameAt = now;
        render(now, deltaMs);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      renderer.forceContextLoss();
      for (const d of disposables) d.dispose();
      mount.removeChild(renderer.domElement);
    };
  }

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}
