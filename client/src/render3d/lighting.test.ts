// The renderer's pure lighting helpers (P10-03, P10-19, P10-20): quality, shadow spec and fit, sky key, glint phase.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { glintPhase } from './glass';
import { fitSunShadow, keepLuminance, parseQuality, shadowSpec, sunPosition } from './scene';
import { skyKey, type SkyColors } from './sky';

describe('parseQuality', () => {
  it('reads the three levels and nothing else', () => {
    expect(parseQuality('?quality=low')).toBe('low');
    expect(parseQuality('?mock=1&quality=high')).toBe('high');
    expect(parseQuality('?quality=medium')).toBe('medium');
    expect(parseQuality('?quality=ultra')).toBeNull();
    expect(parseQuality('')).toBeNull();
    expect(parseQuality(null)).toBeNull();
    expect(parseQuality(undefined)).toBeNull();
  });
});

describe('shadowSpec', () => {
  it('has no shadows on low, a bigger and more frequent map on high', () => {
    expect(shadowSpec('low')).toBeNull();
    const m = shadowSpec('medium')!;
    const h = shadowSpec('high')!;
    expect(m.size).toBe(2048);
    expect(h.size).toBeGreaterThan(m.size);
    expect(h.every).toBeLessThan(m.every);
  });
});

describe('fitSunShadow', () => {
  const b = { x0: 0, z0: 0, x1: 24, z1: 14.5, h: 3.6 };
  it('covers the whole building box from any sun position of the day', () => {
    for (const [az, el] of [[0, 0.1], [Math.PI / 4, 0.7], [Math.PI / 2, 1], [Math.PI, 0.05]] as const) {
      const sun = new THREE.DirectionalLight();
      const p = sunPosition(az, el);
      sun.position.set(12 + p.x, p.y, 7 + p.z);
      sun.target.position.set(12, 0, 7.25);
      fitSunShadow(sun, b);
      const cam = sun.shadow.camera;
      const view = cam.matrixWorld.clone().invert();
      for (const x of [b.x0, b.x1]) for (const y of [0, b.h]) for (const z of [b.z0, b.z1]) {
        const c = new THREE.Vector3(x, y, z).applyMatrix4(view);
        expect(c.x).toBeGreaterThanOrEqual(cam.left);
        expect(c.x).toBeLessThanOrEqual(cam.right);
        expect(c.y).toBeGreaterThanOrEqual(cam.bottom);
        expect(c.y).toBeLessThanOrEqual(cam.top);
        expect(-c.z).toBeGreaterThan(cam.near);
        expect(-c.z).toBeLessThan(cam.far);
      }
    }
  });
});

describe('sunPosition', () => {
  it('rises in the east, sets in the west, stays on the camera side, and is lower than 70 degrees', () => {
    const dawn = sunPosition(0, 0.1);
    const dusk = sunPosition(Math.PI, 0.1);
    expect(dawn.x).toBeGreaterThan(0);
    expect(dusk.x).toBeLessThan(0);
    const noon = sunPosition(Math.PI / 2, 1);
    expect(noon.z).toBeGreaterThan(0);
    // short shadows are invisible shadows: the noon sun must not stand straight above
    expect(Math.atan2(noon.y, Math.hypot(noon.x, noon.z)) * (180 / Math.PI)).toBeLessThan(70);
  });
});

describe('skyKey', () => {
  const sky = (): SkyColors => ({
    top: new THREE.Color('#9fc2ea'),
    horizon: new THREE.Color('#dfe6ee'),
    ground: new THREE.Color('#888888'),
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color('#fff3df'),
    sun: 1,
  });
  it('is stable for tiny changes and changes for visible ones', () => {
    const a = sky();
    const b = sky();
    b.top.r += 0.001;
    expect(skyKey(b)).toBe(skyKey(a));
    const c = sky();
    c.sunDir.set(0.5, 0.8, 0.3).normalize();
    expect(skyKey(c)).not.toBe(skyKey(a));
    const d = sky();
    d.sun = 0;
    expect(skyKey(d)).not.toBe(skyKey(a));
    const e = sky();
    e.horizon.set('#2a3566');
    expect(skyKey(e)).not.toBe(skyKey(a));
  });
});

describe('glintPhase', () => {
  it('sweeps 0 to 1 from sunrise to sunset and holds outside the day', () => {
    expect(glintPhase(6)).toBeCloseTo(0, 6);
    expect(glintPhase(12)).toBeCloseTo(0.5, 6);
    expect(glintPhase(18)).toBeCloseTo(1, 6);
    expect(glintPhase(3)).toBe(0);
    expect(glintPhase(23)).toBe(1);
    expect(glintPhase(10)).toBeLessThan(glintPhase(14));
  });
});

describe('keepLuminance', () => {
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  it('changes the hue but not the brightness', () => {
    const like = new THREE.Color('#ffeedd');
    const tinted = keepLuminance(new THREE.Color('#3355ff'), like);
    expect(lum(tinted)).toBeCloseTo(lum(like), 5);
    expect(tinted.b).toBeGreaterThan(tinted.r);
  });
  it('falls back to the reference for black', () => {
    const like = new THREE.Color('#808080');
    expect(keepLuminance(new THREE.Color(0, 0, 0), like).getHex()).toBe(like.getHex());
  });
});
