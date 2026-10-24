// Sounds and notifications (P6-05, P6-06): preferences, notice sounds and the tab title.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOUND_SETTINGS } from '../audio/scheduler';
import { DEFAULT_ALERT_PREFS, noticeSound, sanitizeAlertPrefs, tabTitle } from './alerts';

describe('alerts', () => {
  it('everything is off by default; corrupted preferences fall back', () => {
    expect(DEFAULT_ALERT_PREFS.sound).toBe(false);
    expect(DEFAULT_ALERT_PREFS.browserNotifications).toBe(false);
    expect(sanitizeAlertPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
    expect(sanitizeAlertPrefs({ sound: 'yes', sounds: { volume: 'x', keys: false }, browserNotifications: 1 })).toEqual({
      sound: false,
      sounds: { ...DEFAULT_SOUND_SETTINGS, keys: false },
      browserNotifications: false,
    });
    expect(sanitizeAlertPrefs({ sound: true, browserNotifications: true })).toMatchObject({ sound: true, browserNotifications: true });
  });

  it('the bell for "needs you", a click for good news, silence otherwise', () => {
    expect(noticeSound({ level: 'alert' })).toBe('chime');
    expect(noticeSound({ level: 'success' })).toBe('pop');
    expect(noticeSound({ level: 'info' })).toBeNull();
    expect(noticeSound({ level: 'warn' })).toBeNull();
  });

  it('the tab title counts who waits for you', () => {
    expect(tabTitle(null)).toBe('Agent Office');
    const a = (status: string) => ({ status }) as never;
    expect(tabTitle({ agents: [a('working'), a('waiting'), a('waiting')] })).toBe('(2) Agent Office');
    expect(tabTitle({ agents: [a('idle')] })).toBe('Agent Office');
  });
});
