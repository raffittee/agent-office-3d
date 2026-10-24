// The renderer and the scene (P2-05): color management, lights, resizing with a capped device pixel ratio.
import * as THREE from 'three';

export type Quality = 'low' | 'medium' | 'high';

export interface SceneParts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Fits the drawing buffer to the canvas' CSS size; returns true if it changed. */
  resize(): boolean;
  dispose(): void;
}

/** The device pixel ratio actually used: capped so a 4K or phone screen doesn't triple the fill cost. */
export function cappedDpr(dpr: number, quality: Quality): number {
  const cap = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
  return Math.max(1, Math.min(dpr || 1, cap));
}

export function createScene(canvas: HTMLCanvasElement, quality: Quality = 'medium'): SceneParts {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor('#dfe3e8');

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight('#ffffff', '#b9b2a6', 1.9);
  const sun = new THREE.DirectionalLight('#fff3df', 1.6);
  sun.position.set(-20, 40, 30);
  scene.add(hemi, sun, sun.target);

  let w = 0;
  let h = 0;
  let dpr = 0;
  const resize = (): boolean => {
    const cw = Math.max(1, canvas.clientWidth);
    const ch = Math.max(1, canvas.clientHeight);
    const d = cappedDpr(window.devicePixelRatio, quality);
    if (cw === w && ch === h && d === dpr) return false;
    w = cw;
    h = ch;
    dpr = d;
    renderer.setPixelRatio(d);
    renderer.setSize(cw, ch, false);
    return true;
  };
  resize();

  return {
    renderer,
    scene,
    sun,
    hemi,
    resize,
    dispose() {
      renderer.dispose();
    },
  };
}
