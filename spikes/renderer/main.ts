// P0-06 renderer spike (throwaway). Measures what a 15-room office with 30 walking characters costs in Three.js.
// URL parameters:
//   cam=ortho|persp   cut=none|hide|cut|fade   chars=instanced|meshes|skinned   shadows=0|1   labels=0|1
//   agents=<n>        rotate=0|1 (orbit the camera)   yaw=<deg>   measure=0|1   seconds=<n>   aa=0|1 (MSAA)
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PathFinder } from './path/astar';
import { BLOCKED, FREE, SEAT, WalkGrid } from './path/grid';

const q = new URLSearchParams(location.search);
const CAM = q.get('cam') ?? 'ortho';
const CUT = q.get('cut') ?? 'hide';
const CHARS = q.get('chars') ?? 'meshes';
const SHADOWS = q.get('shadows') === '1';
const LABELS = q.get('labels') !== '0';
const N_AGENTS = Number(q.get('agents') ?? 30);
const ROTATE = q.get('rotate') !== '0';
const YAW0 = Number(q.get('yaw') ?? 45);
const MEASURE = q.get('measure') !== '0';
const SECONDS = Number(q.get('seconds') ?? 10);

// ---------------------------------------------------------------- layout: 5 × 3 rooms of 16 × 12 tiles, 2-tile corridors
const ROOM_W = 16;
const ROOM_D = 12;
const COR = 2;
const COLS = 5;
const ROWS = 3;
const WALL_H = 3;
const W = COLS * ROOM_W + (COLS + 1) * COR;
const D = ROWS * ROOM_D + (ROWS + 1) * COR;

const enum Side { N, S, W, E }
interface WallSeg { x: number; z: number; side: Side }
interface Placement { x: number; z: number; w: number; d: number; room: number }

const grid = new WalkGrid(W, D);
grid.fill(0, 0, W, D, FREE);
const walls: WallSeg[] = [];
const desks: Placement[] = [];
const chairs: Placement[] = [];
const props: Record<'coffee' | 'sofa' | 'plant', Placement[]> = { coffee: [], sofa: [], plant: [] };

for (let ry = 0; ry < ROWS; ry++) {
  for (let rx = 0; rx < COLS; rx++) {
    const room = ry * COLS + rx;
    const x0 = COR + rx * (ROOM_W + COR);
    const z0 = COR + ry * (ROOM_D + COR);
    const doorA = x0 + 7;
    for (let x = x0; x < x0 + ROOM_W; x++) {
      walls.push({ x, z: z0, side: Side.N });
      grid.set(x, z0, BLOCKED);
      if (x === doorA || x === doorA + 1) continue;
      walls.push({ x, z: z0 + ROOM_D - 1, side: Side.S });
      grid.set(x, z0 + ROOM_D - 1, BLOCKED);
    }
    for (let z = z0; z < z0 + ROOM_D; z++) {
      walls.push({ x: x0, z, side: Side.W }, { x: x0 + ROOM_W - 1, z, side: Side.E });
      grid.set(x0, z, BLOCKED);
      grid.set(x0 + ROOM_W - 1, z, BLOCKED);
    }
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 3; i++) {
        const dx = x0 + 2 + i * 4;
        const dz = z0 + 3 + j * 4;
        desks.push({ x: dx, z: dz, w: 2, d: 1, room });
        grid.fill(dx, dz, 2, 1, BLOCKED);
        chairs.push({ x: dx, z: dz + 1, w: 1, d: 1, room });
        grid.set(dx, dz + 1, SEAT);
      }
    }
    props.coffee.push({ x: x0 + ROOM_W - 3, z: z0 + 1, w: 1, d: 1, room });
    props.sofa.push({ x: x0 + 1, z: z0 + ROOM_D - 3, w: 3, d: 1, room });
    props.plant.push({ x: x0 + 1, z: z0 + 1, w: 1, d: 1, room });
    grid.set(x0 + ROOM_W - 3, z0 + 1, BLOCKED);
    grid.fill(x0 + 1, z0 + ROOM_D - 3, 3, 1, BLOCKED);
    grid.set(x0 + 1, z0 + 1, BLOCKED);
  }
}

// ---------------------------------------------------------------- renderer, scene, lights
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: q.get('aa') !== '0', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = SHADOWS;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.className = 'labels';
app.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dfe6ee');
scene.add(new THREE.HemisphereLight('#ffffff', '#8a8578', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(W / 2 - 30, 60, D / 2 + 40);
sun.target.position.set(W / 2, 0, D / 2);
scene.add(sun, sun.target);
if (SHADOWS) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -W * 0.65;
  c.right = W * 0.65;
  c.top = D * 0.9;
  c.bottom = -D * 0.9;
  c.near = 1;
  c.far = 200;
}

const ROOM_TINTS = ['#f2ede4', '#e7eef2', '#efe7f1', '#e9f0e5', '#f3ebe1'];

// ---------------------------------------------------------------- floor: one merged mesh
{
  const parts: THREE.BufferGeometry[] = [];
  const add = (x: number, z: number, w: number, d: number, y: number, color: string): void => {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x + w / 2, y, z + d / 2);
    const c = new THREE.Color(color);
    const cols = new Float32Array(g.attributes.position!.count * 3);
    for (let i = 0; i < cols.length; i += 3) c.toArray(cols, i);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  add(0, 0, W, D, 0, '#b9b4ab');
  for (let r = 0; r < COLS * ROWS; r++) {
    const x0 = COR + (r % COLS) * (ROOM_W + COR);
    const z0 = COR + Math.floor(r / COLS) * (ROOM_D + COR);
    add(x0, z0, ROOM_W, ROOM_D, 0.01, ROOM_TINTS[r % ROOM_TINTS.length]!);
  }
  const floor = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  floor.receiveShadow = true;
  scene.add(floor);
}

// ---------------------------------------------------------------- walls: instanced, with a cutaway mode
const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const wallMat = new THREE.MeshStandardMaterial({ color: '#f7f5f0', roughness: 0.85 });
const fadeMat = new THREE.MeshStandardMaterial({ color: '#f7f5f0', roughness: 0.85, transparent: true, opacity: 0.22, depthWrite: false });
const wallMesh = new THREE.InstancedMesh(box, wallMat, walls.length);
const fadeMesh = new THREE.InstancedMesh(box, fadeMat, walls.length);
for (const m of [wallMesh, fadeMesh]) {
  m.frustumCulled = false;
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
}
fadeMesh.castShadow = false;
fadeMesh.count = 0;

const NORMALS: Record<Side, [number, number]> = { [Side.N]: [0, -1], [Side.S]: [0, 1], [Side.W]: [-1, 0], [Side.E]: [1, 0] };
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

function wallMatrix(s: WallSeg, h: number): THREE.Matrix4 {
  const t = 0.18;
  if (s.side === Side.N || s.side === Side.S) {
    tmpP.set(s.x + 0.5, 0, s.side === Side.N ? s.z + t / 2 : s.z + 1 - t / 2);
    tmpS.set(1, h, t);
  } else {
    tmpP.set(s.side === Side.W ? s.x + t / 2 : s.x + 1 - t / 2, 0, s.z + 0.5);
    tmpS.set(t, h, 1);
  }
  return tmpM.compose(tmpP, tmpQ.identity(), tmpS);
}

let lastFacing = -1;
let cutawayUpdates = 0;
/** Re-lays the wall instances only when the set of camera-facing sides changes (once per 90° of orbit). */
function applyCutaway(yawRad: number): void {
  const cx = Math.sin(yawRad);
  const cz = Math.cos(yawRad);
  let facing = 0;
  for (const side of [Side.N, Side.S, Side.W, Side.E]) {
    const [nx, nz] = NORMALS[side];
    if (nx * cx + nz * cz > 0.3) facing |= 1 << side;
  }
  if (facing === lastFacing) return;
  lastFacing = facing;
  cutawayUpdates++;
  let o = 0;
  let f = 0;
  for (const s of walls) {
    const front = (facing & (1 << s.side)) !== 0 && CUT !== 'none';
    if (!front) wallMesh.setMatrixAt(o++, wallMatrix(s, WALL_H));
    else if (CUT === 'cut') wallMesh.setMatrixAt(o++, wallMatrix(s, 0.35));
    else if (CUT === 'fade') fadeMesh.setMatrixAt(f++, wallMatrix(s, WALL_H));
    // 'hide': skip the instance
  }
  wallMesh.count = o;
  fadeMesh.count = f;
  wallMesh.instanceMatrix.needsUpdate = true;
  fadeMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- furniture: one InstancedMesh per kind
function furniture(list: Placement[], size: [number, number, number], color: string, yOffset = 0, tint = false): void {
  const m = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: tint ? '#ffffff' : color, roughness: 0.7 }), list.length);
  const c = new THREE.Color();
  list.forEach((p, i) => {
    tmpP.set(p.x + p.w / 2, yOffset, p.z + p.d / 2);
    tmpS.set(size[0], size[1], size[2]);
    m.setMatrixAt(i, tmpM.compose(tmpP, tmpQ.identity(), tmpS));
    if (tint) m.setColorAt(i, c.set(color).offsetHSL((p.room * 0.07) % 1, 0, 0));
  });
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
}
furniture(desks, [1.9, 0.75, 0.9], '#a77b52');
furniture(desks.map((d) => ({ ...d, w: 1 })), [0.6, 0.4, 0.06], '#2b2f36', 0.75);
furniture(chairs, [0.5, 0.5, 0.5], '#3d6fb6', 0, true);
furniture(props.coffee, [0.6, 1.3, 0.5], '#5a5f66');
furniture(props.sofa, [2.8, 0.8, 0.9], '#c65b4a', 0, true);
furniture(props.plant, [0.5, 1.4, 0.5], '#4f9a52');

// ---------------------------------------------------------------- characters
interface Agent {
  x: number;
  z: number;
  yaw: number;
  path: number[];
  pi: number;
  speed: number;
  phase: number;
  obj?: THREE.Object3D;
  bones?: THREE.Bone[];
  label?: CSS2DObject;
  anchor?: THREE.Object3D;
}

const pf = new PathFinder(grid);
const freeTiles: number[] = [];
for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (grid.get(x, z) === FREE) freeTiles.push(z * W + x);
let seed = 7;
const rand = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const NAMES = ['Ana', 'Kenji', 'Amara', 'Lukas', 'Priya', 'Mateo', 'Sofia', 'Tariq', 'Mei', 'Olu', 'Ines', 'Ravi', 'Freya', 'Jonas', 'Leila'];
const PROVIDER_COLORS = ['#d97757', '#4285f4', '#10a37f', '#8e44ad'];

const agents: Agent[] = [];
for (let i = 0; i < N_AGENTS; i++) {
  const t = freeTiles[Math.floor(rand() * freeTiles.length)]!;
  agents.push({ x: (t % W) + 0.5, z: Math.floor(t / W) + 0.5, yaw: 0, path: [], pi: 0, speed: 1.2 + rand() * 0.5, phase: rand() * 10 });
}

const capsule = new THREE.CapsuleGeometry(0.24, 0.6, 4, 10).translate(0, 0.55, 0);
const head = new THREE.SphereGeometry(0.2, 14, 10);
const badge = new THREE.BoxGeometry(0.14, 0.14, 0.04);
const skin = new THREE.MeshStandardMaterial({ color: '#f1c7a5', roughness: 0.8 });
let bodies: THREE.InstancedMesh | undefined;
let heads: THREE.InstancedMesh | undefined;

if (CHARS === 'instanced') {
  bodies = new THREE.InstancedMesh(capsule, new THREE.MeshStandardMaterial({ roughness: 0.7 }), N_AGENTS);
  heads = new THREE.InstancedMesh(head, skin, N_AGENTS);
  const c = new THREE.Color();
  for (let i = 0; i < N_AGENTS; i++) bodies.setColorAt(i, c.setHSL(rand(), 0.55, 0.5));
  for (const m of [bodies, heads]) {
    m.frustumCulled = false;
    m.castShadow = true;
    scene.add(m);
  }
}

function makeSkinned(color: THREE.Color): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[]; top: THREE.Bone } {
  const segs = 4;
  const h = 1.2;
  const geo = new THREE.CylinderGeometry(0.22, 0.26, h, 10, segs * 2, false).translate(0, h / 2, 0);
  const pos = geo.attributes.position!;
  const idx: number[] = [];
  const wts: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / (h / segs);
    const b = Math.max(0, Math.min(segs - 1, Math.floor(y)));
    const w = Math.max(0, Math.min(1, y - b));
    idx.push(b, Math.min(segs - 1, b + 1), 0, 0);
    wts.push(1 - w, w, 0, 0);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  const bones: THREE.Bone[] = [];
  for (let b = 0; b < segs; b++) {
    const bone = new THREE.Bone();
    bone.position.y = b === 0 ? 0 : h / segs;
    if (b > 0) bones[b - 1]!.add(bone);
    bones.push(bone);
  }
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return { mesh, bones, top: bones[segs - 1]! };
}

agents.forEach((a, i) => {
  const color = new THREE.Color().setHSL(rand(), 0.55, 0.5);
  const anchor = new THREE.Object3D();
  if (CHARS === 'meshes') {
    const g = new THREE.Group();
    const b = new THREE.Mesh(capsule, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
    const hd = new THREE.Mesh(head, skin);
    hd.position.y = 1.32;
    const bd = new THREE.Mesh(badge, new THREE.MeshStandardMaterial({ color: PROVIDER_COLORS[i % PROVIDER_COLORS.length], emissive: PROVIDER_COLORS[i % PROVIDER_COLORS.length], emissiveIntensity: 0.4 }));
    bd.position.set(0, 0.85, 0.25);
    for (const m of [b, hd, bd]) m.castShadow = true;
    g.add(b, hd, bd);
    scene.add(g);
    a.obj = g;
  } else if (CHARS === 'skinned') {
    const s = makeSkinned(color);
    const hd = new THREE.Mesh(head, skin);
    hd.position.y = 0.45;
    s.top.add(hd);
    scene.add(s.mesh);
    a.obj = s.mesh;
    a.bones = s.bones;
  }
  anchor.position.y = 1.9;
  if (a.obj) a.obj.add(anchor);
  else scene.add(anchor);
  a.anchor = anchor;
  if (LABELS) {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = `${NAMES[i % NAMES.length]} · ${['typing', 'idle', 'needs you', 'coffee'][i % 4]}`;
    a.label = new CSS2DObject(el);
    anchor.add(a.label);
  }
});

// ---------------------------------------------------------------- simulation step
const pathBuf: number[] = [];
let pathSearches = 0;
let pathMs = 0;
function step(a: Agent, dt: number): void {
  if (a.pi >= a.path.length) {
    const t = freeTiles[Math.floor(rand() * freeTiles.length)]!;
    const t0 = performance.now();
    pf.find(Math.floor(a.x), Math.floor(a.z), t % W, Math.floor(t / W), pathBuf);
    pathMs += performance.now() - t0;
    pathSearches++;
    a.path = pathBuf.slice();
    a.pi = 0;
    if (!a.path.length) return;
  }
  const tx = a.path[a.pi]! + 0.5;
  const tz = a.path[a.pi + 1]! + 0.5;
  const dx = tx - a.x;
  const dz = tz - a.z;
  const dist = Math.hypot(dx, dz);
  const move = a.speed * dt;
  if (dist <= move) {
    a.x = tx;
    a.z = tz;
    a.pi += 2;
  } else {
    a.x += (dx / dist) * move;
    a.z += (dz / dist) * move;
  }
  const want = Math.atan2(dx, dz);
  let d = want - a.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  a.yaw += d * Math.min(1, dt * 10);
}

const euler = new THREE.Euler();
function updateCharacters(dt: number, t: number): void {
  agents.forEach((a, i) => {
    step(a, dt);
    const bob = Math.abs(Math.sin((t + a.phase) * 9)) * 0.05;
    if (bodies && heads) {
      tmpP.set(a.x, bob, a.z);
      tmpQ.setFromEuler(euler.set(0, a.yaw, 0));
      bodies.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS.set(1, 1, 1)));
      tmpP.y += 1.32;
      heads.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      a.anchor!.position.set(a.x, 1.9, a.z);
    } else if (a.obj) {
      a.obj.position.set(a.x, bob, a.z);
      a.obj.rotation.y = a.yaw;
      if (a.bones) {
        const s = Math.sin((t + a.phase) * 9);
        a.bones[1]!.rotation.z = s * 0.12;
        a.bones[2]!.rotation.x = s * 0.1;
        a.bones[3]!.rotation.z = -s * 0.08;
      }
    }
  });
  if (bodies && heads) {
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- cameras
const target = new THREE.Vector3(W / 2, 0, D / 2);
const PITCH = THREE.MathUtils.degToRad(35.264); // true isometric
const aspect = innerWidth / innerHeight;
const HALF_H = 29;
const camera: THREE.OrthographicCamera | THREE.PerspectiveCamera =
  CAM === 'persp'
    ? new THREE.PerspectiveCamera(30, aspect, 1, 600)
    : new THREE.OrthographicCamera(-HALF_H * aspect, HALF_H * aspect, HALF_H, -HALF_H, 1, 600);
const DIST = CAM === 'persp' ? HALF_H / Math.tan(THREE.MathUtils.degToRad(15)) : 150;

function placeCamera(yawRad: number): void {
  camera.position.set(
    target.x + DIST * Math.cos(PITCH) * Math.sin(yawRad),
    target.y + DIST * Math.sin(PITCH),
    target.z + DIST * Math.cos(PITCH) * Math.cos(yawRad),
  );
  camera.lookAt(target);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loop + measurement
const hud = document.getElementById('hud')!;
const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';

const frameIntervals: number[] = [];
const cpuTimes: number[] = [];
let last = performance.now();
let start = last;
const WARMUP = 3000;
let done = false;

function frame(now: number, dt: number): number {
  const t = (now - start) / 1000;
  const yaw = THREE.MathUtils.degToRad(YAW0 + (ROTATE ? t * 12 : 0));
  const t0 = performance.now();
  updateCharacters(dt, t);
  placeCamera(yaw);
  applyCutaway(yaw);
  renderer.render(scene, camera);
  if (LABELS) labelRenderer.render(scene, camera);
  return performance.now() - t0;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] ?? 0;
}

function finish(): void {
  done = true;
  const info = renderer.info;
  const calls = info.render.calls;
  const triangles = info.render.triangles;
  // Burst: 60 frames back to back, each forced to finish on the GPU with a 1-pixel readPixels.
  const px = new Uint8Array(4);
  const burst: number[] = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    frame(performance.now(), 1 / 60);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    burst.push(performance.now() - t0);
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const seconds = frameIntervals.reduce((s, x) => s + x, 0) / 1000;
  (window as unknown as { __result: unknown }).__result = {
    config: { cam: CAM, cut: CUT, chars: CHARS, shadows: SHADOWS, labels: LABELS, agents: N_AGENTS },
    gpu,
    viewport: [innerWidth, innerHeight, renderer.getPixelRatio()],
    fps: frameIntervals.length / seconds,
    frameMsP50: pct(frameIntervals, 50),
    frameMsP95: pct(frameIntervals, 95),
    cpuMsP50: pct(cpuTimes, 50),
    cpuMsP95: pct(cpuTimes, 95),
    burstMsP50: pct(burst, 50),
    burstMsP95: pct(burst, 95),
    drawCalls: calls,
    triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
    jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
    walls: walls.length,
    cutawayUpdates,
    pathSearches,
    pathMsAvg: pathSearches ? pathMs / pathSearches : 0,
  };
  hud.textContent = JSON.stringify((window as unknown as { __result: unknown }).__result, null, 1);
}

function loop(now: number): void {
  const dtMs = now - last;
  last = now;
  const cpu = frame(now, Math.min(dtMs, 100) / 1000);
  const elapsed = now - start;
  if (MEASURE && !done && elapsed > WARMUP) {
    frameIntervals.push(dtMs);
    cpuTimes.push(cpu);
    if (elapsed > WARMUP + SECONDS * 1000) finish();
  }
  if (!MEASURE) hud.textContent = `${(1000 / dtMs).toFixed(0)} fps · ${renderer.info.render.calls} calls · ${gpu}`;
  if (!done) requestAnimationFrame(loop);
}

(window as unknown as { __scene: THREE.Scene }).__scene = scene;
start = last = performance.now();
requestAnimationFrame(loop);
