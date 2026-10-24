// Sounds and notifications (P6-05, P6-06), both off by default. The sound board plays the world's ambient cues
// (keys, elevator, games) and the notice cues (a bell when someone needs you, a click when something finishes); a
// browser notification calls you back when an agent needs you and the tab is hidden; the tab title counts who is
// waiting. Ported in spirit from habblaud client/src/ui/{sound,notify}.ts (MIT, © 2026 Márcio Junior).
import { t } from '../../../shared/i18n';
import type { Notice, OfficeSnapshot } from '../../../shared/protocol';
import { SoundBoard } from '../audio/board';
import { DEFAULT_SOUND_SETTINGS, sanitizeSoundSettings, type SoundKind, type SoundSettings } from '../audio/scheduler';
import type { OfficeStore } from '../net/store';
import type { WorldApi } from '../render3d/world';
import { prefs } from './dom';

export const ALERTS_KEY = 'alerts';
const BASE_TITLE = 'Agent Office';

export interface AlertPrefs {
  /** Master sound switch (off by default). */
  sound: boolean;
  sounds: SoundSettings;
  /** Browser notifications when the tab is hidden (off by default; asks for permission when turned on). */
  browserNotifications: boolean;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = { sound: false, sounds: DEFAULT_SOUND_SETTINGS, browserNotifications: false };

export function sanitizeAlertPrefs(raw: unknown): AlertPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { sound: o.sound === true, sounds: sanitizeSoundSettings(o.sounds), browserNotifications: o.browserNotifications === true };
}

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** The sound a notice makes: the bell for "needs you" (and red CI), a click for good news, nothing otherwise. */
export function noticeSound(n: Pick<Notice, 'level'>): SoundKind | null {
  if (n.level === 'alert') return 'chime';
  if (n.level === 'success') return 'pop';
  return null;
}

/** The tab title: how many agents wait for you, in front. */
export function tabTitle(snap: Pick<OfficeSnapshot, 'agents'> | null): string {
  const waiting = snap ? snap.agents.filter((a) => a.status === 'waiting').length : 0;
  return waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
}

export class Alerts {
  readonly board = new SoundBoard();
  private prefs: AlertPrefs;
  private previewAt = 0;

  constructor(
    store: OfficeStore,
    private readonly world: WorldApi,
  ) {
    this.prefs = sanitizeAlertPrefs(prefs.get(ALERTS_KEY, DEFAULT_ALERT_PREFS));
    this.board.configure(this.prefs.sound, this.prefs.sounds);
    world.onSound((cue) => this.board.play(cue.kind, cue));
    store.on('notice', (n) => this.onNotice(n));
    store.on('snapshot', (snap) => {
      const title = tabTitle(snap);
      if (document.title !== title) document.title = title;
    });
    // browsers allow audio only after a user gesture
    const unlock = () => {
      if (this.prefs.sound) void this.board.unlock();
    };
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
  }

  get(): AlertPrefs {
    return { ...this.prefs, sounds: { ...this.prefs.sounds } };
  }

  set(patch: Partial<AlertPrefs>): void {
    this.prefs = sanitizeAlertPrefs({ ...this.prefs, ...patch });
    this.board.configure(this.prefs.sound, this.prefs.sounds);
    prefs.set(ALERTS_KEY, this.prefs);
  }

  /** A sample when a setting changes (called from the click, which unlocks audio). */
  preview(kind: SoundKind = 'pop'): void {
    const ready = this.board.unlock();
    const now = performance.now();
    if (now - this.previewAt < 250) return;
    this.previewAt = now;
    // the first resume() of the AudioContext is asynchronous
    void ready.then(() => this.board.play(kind));
  }

  /** Turning browser notifications on asks for permission; returns the final state. */
  async enableBrowserNotifications(): Promise<NotificationState> {
    const state = notificationState();
    if (state !== 'default') return state;
    try {
      return await Notification.requestPermission();
    } catch {
      return notificationState();
    }
  }

  private onNotice(n: Notice): void {
    // the bell plays even with the tab hidden (it calls you back); the click only when visible (the board decides)
    const kind = noticeSound(n);
    if (kind) this.board.play(kind);
    if (n.level !== 'alert' || !this.prefs.browserNotifications || !document.hidden || notificationState() !== 'granted') return;
    try {
      const notification = new Notification(t('Agent Office — an agent needs you'), { body: n.text, tag: n.agentId ?? n.id });
      notification.onclick = () => {
        window.focus();
        if (n.agentId) this.world.select({ type: 'agent', id: n.agentId }, { focus: true });
        notification.close();
      };
    } catch {
      // some browsers allow notifications only through a service worker; the toast still shows
    }
  }
}
