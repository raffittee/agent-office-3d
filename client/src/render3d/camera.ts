// The camera rig (P2-05, ADR 0003): orthographic isometric (pitch 35.264°, yaw 45° + k·90°), rotation in animated
// 90° steps, zoom towards the cursor, pan, "frame the office" and following an agent. Plus pointer/keyboard input.
import * as THREE from 'three';
import { reducedMotion } from '../a11y';

export const PITCH_DEG = 35.264;
/** Visible height (m) limits: from a close look at one desk to a large office. */
export const ZOOM_MIN = 4;
export const ZOOM_MAX = 90;

export interface Bounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Screen margins covered by UI panels (CSS px): framing and centring use the free area. */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEG = Math.PI / 180;

/** Camera axes for a yaw (degrees): right and up vectors of the view plane, and the direction to the camera. */
export function viewAxes(yawDeg: number): { right: THREE.Vector3; up: THREE.Vector3; back: THREE.Vector3 } {
  const y = yawDeg * DEG;
  const p = PITCH_DEG * DEG;
  // direction from the target to the camera
  const back = new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
  const right = new THREE.Vector3(Math.cos(y), 0, -Math.sin(y));
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return { right, up, back };
}

/**
 * The view height (m) and centre that frame a ground rectangle at a yaw, for a viewport aspect ratio and the share of
 * the viewport left free by panels. Pure; tested.
 */
export function frameBounds(b: Bounds, yawDeg: number, aspect: number, free = { w: 1, h: 1 }, margin = 1.08): { zoom: number; x: number; z: number } {
  const { right, up } = viewAxes(yawDeg);
  let minR = Infinity;
  let maxR = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  for (const [x, z] of [
    [b.x0, b.z0],
    [b.x1, b.z0],
    [b.x0, b.z1],
    [b.x1, b.z1],
  ] as const) {
    for (const y of [0, 2.8]) {
      const r = x * right.x + y * right.y + z * right.z;
      const u = x * up.x + y * up.y + z * up.z;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
    }
  }
  const needH = (maxU - minU) / Math.max(0.05, free.h);
  const needW = (maxR - minR) / Math.max(0.05, free.w) / aspect;
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.max(needH, needW) * margin));
  return { zoom, x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
}

/** Shortest-way easing between two angles in degrees. */
function easeAngle(cur: number, goal: number, k: number): number {
  return cur + (goal - cur) * k;
}

export class CameraRig {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  yaw = 45;
  yawGoal = 45;
  zoom = 30;
  zoomGoal = 30;
  readonly target = new THREE.Vector3(10, 0, 8);
  readonly targetGoal = new THREE.Vector3(10, 0, 8);
  /** Followed position (an agent), read every frame; null = free camera. */
  follow: (() => { x: number; z: number } | null) | null = null;
  insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private aspect = 1;
  private viewW = 1;
  private viewH = 1;
  private readonly ray = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.aspect = this.viewW / this.viewH;
  }

  /** Eases towards the goals; returns true while anything is still moving. */
  update(dt: number): boolean {
    const f = this.follow?.();
    if (f) this.targetGoal.set(f.x, 0, f.z);
    // reduced motion: no glides, the view jumps straight to where it's going
    const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 9);
    const before = this.yaw + this.zoom + this.target.x + this.target.z;
    this.yaw = Math.abs(this.yawGoal - this.yaw) < 0.01 ? this.yawGoal : easeAngle(this.yaw, this.yawGoal, k);
    this.zoom = Math.abs(this.zoomGoal - this.zoom) < 0.001 ? this.zoomGoal : this.zoom + (this.zoomGoal - this.zoom) * k;
    this.target.lerp(this.targetGoal, k);
    this.apply();
    return Math.abs(before - (this.yaw + this.zoom + this.target.x + this.target.z)) > 1e-4;
  }

  /** Places the camera; the free area between the insets is the visual centre. */
  apply(): void {
    const { back, right, up } = viewAxes(this.yaw);
    const h = this.zoom;
    const w = h * this.aspect;
    // shift the frustum so the target sits in the middle of the area not covered by panels
    const offX = ((this.insets.left - this.insets.right) / 2 / this.viewW) * w;
    const offY = ((this.insets.bottom - this.insets.top) / 2 / this.viewH) * h;
    const cam = this.camera;
    cam.left = -w / 2 - offX;
    cam.right = w / 2 - offX;
    cam.top = h / 2 - offY;
    cam.bottom = -h / 2 - offY;
    const dist = 120;
    cam.position.copy(this.target).addScaledVector(back, dist);
    cam.up.copy(up);
    cam.lookAt(this.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    void right;
  }

  /** The ground point (y = 0) under a viewport position (CSS px), or null. */
  groundAt(px: number, py: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((px / this.viewW) * 2 - 1, -(py / this.viewH) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.intersectPlane(this.ground, new THREE.Vector3());
  }

  /** Pans by a screen drag (CSS px). */
  panBy(dxPx: number, dyPx: number): void {
    this.follow = null;
    const { right } = viewAxes(this.yaw);
    const perPx = this.zoom / this.viewH;
    // screen up maps to "forward on the ground", stretched by the pitch
    const fwd = new THREE.Vector3(-Math.sin(this.yaw * DEG), 0, -Math.cos(this.yaw * DEG));
    const s = 1 / Math.sin(PITCH_DEG * DEG);
    this.targetGoal.addScaledVector(right, -dxPx * perPx).addScaledVector(fwd, dyPx * perPx * s);
    this.target.copy(this.targetGoal);
  }

  /** Zooms by a factor (< 1 = closer), keeping the ground point under (px, py) in place when given. */
  zoomBy(factor: number, px?: number, py?: number): void {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomGoal * factor));
    if (px !== undefined && py !== undefined && !this.follow) {
      const before = this.groundAt(px, py);
      const saved = this.zoom;
      this.zoom = next;
      this.apply();
      const after = this.groundAt(px, py);
      this.zoom = saved;
      this.apply();
      if (before && after) {
        this.targetGoal.add(before.sub(after));
        this.target.copy(this.targetGoal);
      }
    }
    this.zoomGoal = next;
  }

  rotate(steps: number): void {
    this.yawGoal += 90 * steps;
  }

  /** Frames a ground rectangle within the free area. */
  frame(b: Bounds): void {
    const free = { w: 1 - (this.insets.left + this.insets.right) / this.viewW, h: 1 - (this.insets.top + this.insets.bottom) / this.viewH };
    const f = frameBounds(b, this.yawGoal, this.aspect, free);
    this.follow = null;
    this.zoomGoal = f.zoom;
    this.targetGoal.set(f.x, 0, f.z);
  }

  /** Centres on a point, optionally zooming in to `zoom` (m). */
  focus(x: number, z: number, zoom?: number): void {
    this.targetGoal.set(x, 0, z);
    if (zoom !== undefined) this.zoomGoal = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  }

  /** Projects a world point to viewport CSS px (and whether it's in front of the camera). */
  project(v: THREE.Vector3, out: { x: number; y: number }): { x: number; y: number } {
    const p = v.clone().project(this.camera);
    out.x = (p.x * 0.5 + 0.5) * this.viewW;
    out.y = (-p.y * 0.5 + 0.5) * this.viewH;
    return out;
  }

  /** Pixels per metre at the current zoom (for label level of detail). */
  get pxPerMetre(): number {
    return this.viewH / this.zoom;
  }
}

export interface InputHandlers {
  /** A click (no drag) at viewport px. */
  click(x: number, y: number): void;
  hover(x: number, y: number): void;
  leave(): void;
  /** "Frame the office". */
  overview(): void;
  /** Escape: clear the selection. */
  escape(): void;
}

/** Wires pointer, wheel and keyboard input to the rig. Returns a function that removes the listeners. */
export function attachInput(el: HTMLElement, rig: CameraRig, h: InputHandlers): () => void {
  let drag: { id: number; x: number; y: number; moved: boolean; button: number; startX: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const rect = () => el.getBoundingClientRect();

  const onDown = (e: PointerEvent) => {
    el.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      drag = null;
      return;
    }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, button: e.button, startX: e.clientX };
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const r = rect();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0 && d > 0) rig.zoomBy(pinch / d, (a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top);
      pinch = d;
      return;
    }
    if (!drag || drag.id !== e.pointerId) {
      if (e.pointerType === 'mouse') h.hover(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, dy) < 4 && Math.abs(dx) < 4) return;
    drag.moved = true;
    if (drag.button === 2) {
      // right drag: a 90° turn per 120 px
      if (Math.abs(e.clientX - drag.startX) > 120) {
        rig.rotate(e.clientX > drag.startX ? -1 : 1);
        drag.startX = e.clientX;
      }
    } else rig.panBy(dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && drag.button === 0) {
        const r = rect();
        h.click(e.clientX - r.left, e.clientY - r.top);
      }
      drag = null;
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = rect();
    rig.zoomBy(Math.exp(e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 60;
    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
        rig.panBy(step, 0);
        break;
      case 'ArrowRight':
      case 'd':
        rig.panBy(-step, 0);
        break;
      case 'ArrowUp':
      case 'w':
        rig.panBy(0, step);
        break;
      case 'ArrowDown':
      case 's':
        rig.panBy(0, -step);
        break;
      case 'q':
        rig.rotate(1);
        break;
      case 'e':
        rig.rotate(-1);
        break;
      case '+':
      case '=':
        rig.zoomBy(0.8);
        break;
      case '-':
        rig.zoomBy(1.25);
        break;
      case 'f':
        h.overview();
        break;
      case 'Escape':
        h.escape();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const onContext = (e: Event) => e.preventDefault();
  const onLeave = () => h.leave();
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('keydown', onKey);
  el.addEventListener('contextmenu', onContext);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('contextmenu', onContext);
  };
}
