// The DOM overlay above the canvas (P2-08): one label per character (name tag with a provider dot, bubble, icon)
// and one per room (its name), placed from projected 3D positions, with level of detail and decluttering.
import * as THREE from 'three';
import type { Character } from '../core/sim/character';
import type { RoomState } from '../core/sim/room-state';
import type { WorldOptions } from '../core/options';
import type { CameraRig } from './camera';
import type { CharacterView } from './characters';
import { declutter, labelFor, type LabelView } from './labels';
import { tm, WALL_H } from './units';

const CSS = `
.ao-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; font: 12px/1.25 system-ui, sans-serif; }
.ao-overlay [hidden] { display: none !important; }
.ao-label { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
  transform: translate(-50%, -100%); white-space: nowrap; will-change: transform; }
.ao-bubble { max-width: 220px; overflow: hidden; text-overflow: ellipsis; padding: 3px 8px; border-radius: 10px;
  background: var(--panel-solid, #fff); color: var(--text, #222); box-shadow: 0 2px 8px rgba(0,0,0,.18); }
.ao-bubble.alert { background: #ffb347; color: #3a2300; font-weight: 600; animation: ao-pulse 1.1s ease-in-out infinite; }
.ao-bubble.shell { background: #2f3640; color: #e8f0ff; }
.ao-bubble.deliver { background: #fff4d6; color: #4a3500; }
.ao-name { padding: 1px 6px; border-radius: 8px; background: rgba(20,22,26,.72); color: #fff; font-size: 11px;
  display: inline-flex; align-items: center; gap: 4px; }
.ao-name i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.ao-name.selected { background: var(--accent, #3b7bd8); }
.ao-icon { font-size: 16px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,.3)); }
.ao-room { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); padding: 2px 10px; border-radius: 6px;
  background: rgba(255,255,255,.82); color: #2a2d33; font-weight: 600; font-size: 12px; white-space: nowrap;
  box-shadow: 0 1px 4px rgba(0,0,0,.12); }
@media (prefers-color-scheme: dark) { .ao-room { background: rgba(28,31,37,.85); color: #e6e8ec; } }
@keyframes ao-pulse { 50% { transform: scale(1.06); } }
`;

interface Entry {
  el: HTMLDivElement;
  name: HTMLDivElement;
  dot: HTMLElement;
  nameText: Text;
  bubble: HTMLDivElement;
  icon: HTMLDivElement;
  last: string;
}

const tmp = new THREE.Vector3();
const pt = { x: 0, y: 0 };

export class Overlay {
  readonly el = document.createElement('div');
  private entries = new Map<string, Entry>();
  private rooms = new Map<string, HTMLDivElement>();
  providerColors = new Map<string, string>();

  constructor(parent: HTMLElement) {
    this.el.className = 'ao-overlay';
    if (!document.getElementById('ao-overlay-css')) {
      const style = document.createElement('style');
      style.id = 'ao-overlay-css';
      style.textContent = CSS;
      document.head.append(style);
    }
    parent.prepend(this.el);
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    const el = document.createElement('div');
    el.className = 'ao-label';
    const icon = document.createElement('div');
    icon.className = 'ao-icon';
    const bubble = document.createElement('div');
    bubble.className = 'ao-bubble';
    const name = document.createElement('div');
    name.className = 'ao-name';
    const dot = document.createElement('i');
    const nameText = document.createTextNode('');
    name.append(dot, nameText);
    el.append(icon, bubble, name);
    this.el.append(el);
    e = { el, name, dot, nameText, bubble, icon, last: '' };
    this.entries.set(id, e);
    return e;
  }

  update(chars: Iterable<Character>, rooms: Iterable<RoomState>, view: CharacterView, rig: CameraRig, opts: WorldOptions, selected: string | null, now: number): void {
    const zoomPx = rig.pxPerMetre;
    const seen = new Set<string>();
    const byId = new Map<string, Character>();
    for (const c of chars) byId.set(c.id, c);
    const placed: { id: string; rect: { x: number; y: number; w: number; h: number }; priority: number; label: LabelView; x: number; y: number }[] = [];
    for (const c of byId.values()) {
      if (c.gone || c.inside || c.alpha < 0.3) continue;
      const label = labelFor(c, now, opts, c.id === selected, zoomPx);
      if (!label.name && !label.bubble && !label.icon) continue;
      rig.project(view.headPoint(c, tmp), pt);
      const w = Math.max(label.name ? label.name.length * 7 + 22 : 0, label.bubble ? Math.min(220, label.bubble.text.length * 6.5 + 30) : 0, 18);
      const h = (label.name ? 18 : 0) + (label.bubble ? 22 : 0) + (label.icon ? 18 : 0);
      placed.push({ id: c.id, rect: { x: pt.x - w / 2, y: pt.y - h, w, h }, priority: label.priority, label, x: pt.x, y: pt.y });
    }
    // room name tags compete too: above plain names, below bubbles and alerts
    const roomTags = this.placeRooms(rooms, rig, zoomPx);
    const keep = declutter([...placed, ...roomTags]);
    for (const r of roomTags) {
      const el = this.rooms.get(r.roomId)!;
      el.hidden = !keep.has(r.id);
      el.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px) translate(-50%, -50%)`;
    }
    for (const p of placed) {
      // a label that loses the overlap still shows its alert bubble, just without the name
      const kept = keep.has(p.id);
      const label = kept ? p.label : p.label.bubble?.kind === 'alert' ? { ...p.label, name: null, icon: null } : null;
      if (!label) continue;
      seen.add(p.id);
      const e = this.entry(p.id);
      const b = label.bubble;
      const key = `${label.name}|${b?.kind}|${b?.icon}|${b?.text}|${label.icon}|${p.id === selected}`;
      if (key !== e.last) {
        e.last = key;
        e.name.hidden = !label.name;
        e.nameText.data = label.name ?? '';
        e.name.classList.toggle('selected', p.id === selected);
        e.bubble.hidden = !b;
        e.bubble.className = `ao-bubble${b && b.kind !== 'activity' ? ` ${b.kind}` : ''}`;
        e.bubble.textContent = b ? `${b.icon} ${b.text}` : '';
        e.icon.hidden = !label.icon;
        e.icon.textContent = label.icon ?? '';
      }
      e.dot.style.background = this.providerColors.get(byId.get(p.id)?.info.provider ?? '') ?? '#888';
      e.bubble.style.opacity = b ? String(b.opacity) : '1';
      e.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - 4)}px) translate(-50%, -100%)`;
      e.el.hidden = false;
    }
    for (const [id, e] of this.entries) {
      if (seen.has(id)) continue;
      if (byId.has(id)) e.el.hidden = true;
      else {
        e.el.remove();
        this.entries.delete(id);
      }
    }
  }

  /** Room name tags to place (created on demand); tags of rooms that are gone are removed. */
  private placeRooms(rooms: Iterable<RoomState>, rig: CameraRig, zoomPx: number): { id: string; roomId: string; rect: { x: number; y: number; w: number; h: number }; priority: number; x: number; y: number }[] {
    const seen = new Set<string>();
    const out: { id: string; roomId: string; rect: { x: number; y: number; w: number; h: number }; priority: number; x: number; y: number }[] = [];
    for (const r of rooms) {
      if (!r.present || r.ghost || r.phase !== 'ready') continue;
      seen.add(r.id);
      let el = this.rooms.get(r.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ao-room';
        this.el.append(el);
        this.rooms.set(r.id, el);
      }
      if (el.textContent !== r.info.name) el.textContent = r.info.name;
      const rect = r.layout.rect;
      // over the room's back wall, centred
      tmp.set(tm(rect.x + rect.w / 2), WALL_H * 0.15, tm(rect.y + 1));
      rig.project(tmp, pt);
      if (zoomPx < 5) {
        el.hidden = true;
        continue;
      }
      const w = r.info.name.length * 7.5 + 24;
      out.push({ id: `room:${r.id}`, roomId: r.id, rect: { x: pt.x - w / 2, y: pt.y - 11, w, h: 22 }, priority: 8, x: pt.x, y: pt.y });
    }
    for (const [id, el] of this.rooms) {
      if (seen.has(id)) continue;
      el.remove();
      this.rooms.delete(id);
    }
    return out;
  }

  dispose(): void {
    this.el.remove();
  }
}
