// The page's desktop-app helpers that don't need a browser: which mode the app asked for, and the camera insets.
import { describe, expect, it } from 'vitest';
import { INTEGRATION_ROWS, parseShell, WIDGET_BAR_HEIGHT, widgetInsets } from './shell';

describe('desktop shell detection', () => {
  it('knows the app and its mode from the URL it loaded', () => {
    expect(parseShell('?shell=desktop&mode=widget')).toBe('widget');
    expect(parseShell('?shell=desktop&mode=window')).toBe('window');
    expect(parseShell('?shell=desktop')).toBe('window');
    expect(parseShell('?shell=desktop&mode=nonsense')).toBe('window');
  });

  it('is off in a browser', () => {
    for (const search of ['', '?mock=1', '?mode=widget', '?shell=web', '?shell=Desktop']) expect(parseShell(search), search).toBeNull();
  });

  it('leaves room only for the widget bar', () => {
    expect(widgetInsets()).toEqual({ top: WIDGET_BAR_HEIGHT, left: 0, right: 0, bottom: 0 });
  });

  it('describes every integration the app can install', () => {
    expect(Object.keys(INTEGRATION_ROWS).sort()).toEqual(['claude-code', 'codex', 'gemini-cli', 'usage']);
    for (const row of Object.values(INTEGRATION_ROWS)) expect(row.title && row.hint).toBeTruthy();
  });
});
