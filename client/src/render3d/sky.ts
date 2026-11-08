// The sky (P10-03, P10-20): a gradient background that follows the time of day, and a small environment map of the
// same sky (with the sun in it) for the window glass to reflect. The environment map is re-rendered only when the sky
// has visibly changed, at most every couple of seconds, never every frame.
import * as THREE from 'three';

export interface SkyColors {
  /** Top of the view and the zenith of the reflected sky. */
  top: THREE.Color;
  /** Bottom of the view and the horizon of the reflected sky. */
  horizon: THREE.Color;
  /** Below the horizon in reflections (the street, the ground). */
  ground: THREE.Color;
  /** The sun (or moon) disc: direction (world, normalized), color and strength (0 = none). */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sun: number;
}

const ENV_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ENV_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSun;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.6, up));
  vec3 col = up >= 0.0 ? sky : mix(uHorizon, uGround, smoothstep(0.0, 0.25, -up));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uSun * (pow(s, 900.0) * 14.0 + pow(s, 24.0) * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`;

/** The sky's key, quantized: the environment map is rebuilt only when this changes. Pure (tested). */
export function skyKey(c: SkyColors): string {
  const q = (v: number) => Math.round(v * 24);
  const col = (x: THREE.Color) => `${q(x.r)},${q(x.g)},${q(x.b)}`;
  return [col(c.top), col(c.horizon), col(c.ground), col(c.sunColor), q(c.sun), q(c.sunDir.x), q(c.sunDir.y), q(c.sunDir.z)].join('|');
}

export class Sky {
  readonly colors: SkyColors = {
    top: new THREE.Color('#b9d3ee'),
    horizon: new THREE.Color('#e8edf1'),
    ground: new THREE.Color('#8f8a80'),
    sunDir: new THREE.Vector3(0, 1, 0.3).normalize(),
    sunColor: new THREE.Color('#fff3df'),
    sun: 1,
  };
  /** The environment map for reflective materials (null until the first build). */
  envMap: THREE.Texture | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  readonly background: THREE.CanvasTexture;
  private bgKey = '';
  private envKey = '';
  private envAt = -Infinity;
  private pmrem: THREE.PMREMGenerator | null = null;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly envScene = new THREE.Scene();
  private readonly envMat: THREE.ShaderMaterial;
  private readonly listeners = new Set<(env: THREE.Texture) => void>();

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly withEnv: boolean) {
    this.canvas.width = 2;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d');
    this.background = new THREE.CanvasTexture(this.canvas);
    this.background.colorSpace = THREE.SRGBColorSpace;
    this.envMat = new THREE.ShaderMaterial({
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Color() },
        uSun: { value: 0 },
      },
    });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.envMat));
  }

  /** Called when the environment map is (re)built. */
  onEnv(cb: (env: THREE.Texture) => void): () => void {
    this.listeners.add(cb);
    if (this.envMap) cb(this.envMap);
    return () => void this.listeners.delete(cb);
  }

  /** Redraws the background when its colors changed, and the environment map when the sky did (throttled). */
  update(now: number): void {
    const c = this.colors;
    const bg = `${c.top.getHexString()}${c.horizon.getHexString()}`;
    if (bg !== this.bgKey && this.ctx) {
      this.bgKey = bg;
      const g = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
      g.addColorStop(0, `#${c.top.getHexString(THREE.SRGBColorSpace)}`);
      g.addColorStop(1, `#${c.horizon.getHexString(THREE.SRGBColorSpace)}`);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.background.needsUpdate = true;
    }
    if (!this.withEnv) return;
    const key = skyKey(c);
    if (key === this.envKey || now - this.envAt < 2000) return;
    this.envKey = key;
    this.envAt = now;
    const u = this.envMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(c.top);
    (u.uHorizon!.value as THREE.Color).copy(c.horizon);
    (u.uGround!.value as THREE.Color).copy(c.ground);
    (u.uSunDir!.value as THREE.Vector3).copy(c.sunDir);
    (u.uSunColor!.value as THREE.Color).copy(c.sunColor);
    u.uSun!.value = c.sun;
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 20, { size: 64 });
    this.target?.dispose();
    this.target = next;
    this.envMap = next.texture;
    for (const cb of this.listeners) cb(next.texture);
  }

  dispose(): void {
    this.background.dispose();
    this.target?.dispose();
    this.pmrem?.dispose();
    this.envMat.dispose();
    this.listeners.clear();
  }
}
