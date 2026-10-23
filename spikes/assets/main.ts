// P0-07 asset spike (throwaway): load a character GLB (raw or meshopt), clone it N times with SkeletonUtils, play a
// different clip on each through AnimationMixer, and measure load, clone, mixer and frame costs. Also loads the
// merged furniture GLB. URL: ?char=<url>&furniture=<url>&n=30&seconds=8
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 30);
const SECONDS = Number(q.get('seconds') ?? 8);
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#dfe6ee');
scene.add(new THREE.HemisphereLight('#ffffff', '#8a8578', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 2);
sun.position.set(10, 20, 10);
scene.add(sun);
const aspect = innerWidth / innerHeight;
const camera = new THREE.OrthographicCamera(-8 * aspect, 8 * aspect, 8, -8, 0.1, 200);
camera.position.set(20, 20, 20);
camera.lookAt(0, 0, 0);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

async function timedLoad(url: string): Promise<{ gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>; fetchMs: number; parseMs: number; bytes: number }> {
  const t0 = performance.now();
  const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  const t1 = performance.now();
  const gltf = await loader.parseAsync(buf, '');
  return { gltf, fetchMs: t1 - t0, parseMs: performance.now() - t1, bytes: buf.byteLength };
}

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] ?? 0;

async function main(): Promise<void> {
  await MeshoptDecoder.ready;
  const ch = await timedLoad(q.get('char')!);
  const clips = ch.gltf.animations.filter((a) => a.name !== 'A_TPose');
  const t0 = performance.now();
  const mixers: THREE.AnimationMixer[] = [];
  const cols = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) {
    const c = cloneSkinned(ch.gltf.scene);
    c.position.set((i % cols) * 1.6 - cols * 0.8, 0, Math.floor(i / cols) * 1.6 - cols * 0.8);
    scene.add(c);
    const m = new THREE.AnimationMixer(c);
    m.clipAction(clips[i % clips.length]!).play();
    mixers.push(m);
  }
  const cloneMs = performance.now() - t0;

  let furniture: { fetchMs: number; parseMs: number; bytes: number; meshes: number } | null = null;
  if (q.get('furniture')) {
    const f = await timedLoad(q.get('furniture')!);
    let meshes = 0;
    f.gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    furniture = { fetchMs: f.fetchMs, parseMs: f.parseMs, bytes: f.bytes, meshes };
  }

  const mixerMs: number[] = [];
  const frameMs: number[] = [];
  const clock = new THREE.Clock();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const loop = (): void => {
      const dt = clock.getDelta();
      const a = performance.now();
      for (const m of mixers) m.update(dt);
      const b = performance.now();
      renderer.render(scene, camera);
      frameMs.push(performance.now() - a);
      mixerMs.push(b - a);
      if (performance.now() - start < SECONDS * 1000) requestAnimationFrame(loop);
      else resolve();
    };
    requestAnimationFrame(loop);
  });
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const burst: number[] = [];
  for (let i = 0; i < 60; i++) {
    const a = performance.now();
    for (const m of mixers) m.update(1 / 60);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    burst.push(performance.now() - a);
  }
  const result = {
    char: { bytes: ch.bytes, fetchMs: ch.fetchMs, parseMs: ch.parseMs, clips: clips.length },
    furniture,
    n: N,
    cloneMs,
    mixerMsP50: pct(mixerMs, 50),
    mixerMsP95: pct(mixerMs, 95),
    cpuFrameMsP50: pct(frameMs, 50),
    burstMsP50: pct(burst, 50),
    burstMsP95: pct(burst, 95),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
  (window as unknown as { __result: unknown }).__result = result;
  hud.textContent = JSON.stringify(result, null, 1);
}

main().catch((e: unknown) => {
  (window as unknown as { __result: unknown }).__result = { error: String(e) };
});
