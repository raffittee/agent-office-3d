// Settings (the theme picker, P4-09, and the world options) and the help/shortcuts dialog (P2-10).
import { t } from '../../../shared/i18n';
import type { WorldApi, WorldSettings } from '../render3d/world';
import { themes, type ThemeEntry } from '../themes/registry';
import { notificationState, type Alerts } from './alerts';
import { button, el, prefs } from './dom';

export const SETTINGS_KEY = 'world';

export function modal(title: string, body: HTMLElement[], onClose: () => void): HTMLElement {
  const back = el('div', 'ui-modal-back');
  const box = el('div', 'ui-modal');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  const close = button(t('Close'), t('Close (Esc)'), onClose);
  close.style.float = 'right';
  box.append(close, el('h2', '', title), ...body);
  back.append(box);
  back.addEventListener('click', (e) => {
    if (e.target === back) onClose();
  });
  // keep Tab inside the dialog
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  // focus goes back where it was when the dialog closes
  const before = document.activeElement as HTMLElement | null;
  const obs = new MutationObserver(() => {
    if (back.isConnected) return;
    obs.disconnect();
    before?.focus?.();
  });
  // the caller appends the dialog right after this returns: watch only its parent's children
  queueMicrotask(() => back.parentElement && obs.observe(back.parentElement, { childList: true }));
  setTimeout(() => close.focus(), 0);
  return back;
}

function select<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void): HTMLElement {
  const row = el('label', 'ui-field');
  const s = el('select');
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = v;
    o.selected = v === value;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value as T));
  row.append(label, s);
  return row;
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('label', 'ui-field');
  const c = el('input');
  c.type = 'checkbox';
  c.checked = value;
  c.addEventListener('change', () => onChange(c.checked));
  row.append(label, c);
  return row;
}

/** A theme's card: its thumbnail, or a swatch drawn from its colors when the pack has none. */
function themeCard(entry: ThemeEntry, selected: boolean, onPick: () => void): HTMLElement {
  const look = entry.look;
  const card = el('button', `ui-theme${selected ? ' is-selected' : ''}`);
  card.type = 'button';
  card.title = look.pack.description ?? look.name;
  card.setAttribute('aria-pressed', String(selected));
  const pic = el('span', 'ui-theme-pic');
  if (entry.thumbnail) {
    const img = el('img');
    img.src = entry.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    pic.append(img);
  } else {
    const room = look.roomTheme(0);
    const floor = look.floor('room', 'marble').color;
    pic.style.background = `linear-gradient(180deg, ${look.background} 0 18%, ${room.wall.base} 18% 46%, ${room.wall.trim} 46% 49%, ${floor} 49% 100%)`;
    const dots = el('span', 'ui-theme-dots');
    for (let s = 0; s < 4; s++) {
      const d = el('i');
      d.style.background = look.roomTheme(s).accent;
      dots.append(d);
    }
    pic.append(dots);
  }
  card.append(pic, el('span', 'ui-theme-name', look.name));
  card.addEventListener('click', onPick);
  return card;
}

function themePicker(world: WorldApi, set: (patch: Partial<WorldSettings>) => void): HTMLElement {
  const wrap = el('div', 'ui-themes');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('Theme'));
  const render = () => {
    const current = world.theme().look.id;
    wrap.replaceChildren(
      ...themes().map((entry) =>
        themeCard(entry, entry.look.id === current, () => {
          set({ theme: entry.look.id });
          render();
        }),
      ),
    );
  };
  render();
  return wrap;
}

function slider(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = el('label', 'ui-field');
  const r = el('input');
  r.type = 'range';
  r.min = '0';
  r.max = '100';
  r.step = '5';
  r.value = String(Math.round(value * 100));
  r.addEventListener('change', () => onChange(Number(r.value) / 100));
  row.append(label, r);
  return row;
}

/** Sounds (P6-05) and notifications (P6-06): all off by default. */
function alertSettings(alerts: Alerts): HTMLElement[] {
  const a = alerts.get();
  const sounds = el('div', 'ui-subfields');
  const setSounds = (patch: Partial<typeof a.sounds>, sample = true) => {
    alerts.set({ sounds: { ...alerts.get().sounds, ...patch } });
    if (sample) alerts.preview('pop');
  };
  sounds.append(
    slider(t('Volume'), a.sounds.volume, (v) => setSounds({ volume: v })),
    toggle(t('Alerts (someone needs you, something finished)'), a.sounds.alerts, (v) => {
      setSounds({ alerts: v }, false);
      if (v) alerts.preview('chime');
    }),
    toggle(t('Typing'), a.sounds.keys, (v) => setSounds({ keys: v }, false)),
    toggle(t('Elevator'), a.sounds.elevator, (v) => {
      setSounds({ elevator: v }, false);
      if (v) alerts.preview('elevator');
    }),
    toggle(t('Games (ping-pong, arcade)'), a.sounds.social, (v) => setSounds({ social: v }, false)),
  );
  sounds.hidden = !a.sound;
  const note = el('p', 'ui-empty');
  const showState = () => {
    const st = notificationState();
    note.textContent =
      st === 'denied' ? t('The browser blocks notifications for this page; allow them in the site settings.') : st === 'unsupported' ? t('This browser has no notifications.') : '';
    note.hidden = !note.textContent;
  };
  showState();
  return [
    toggle(t('Sounds'), a.sound, (v) => {
      alerts.set({ sound: v });
      sounds.hidden = !v;
      if (v) alerts.preview('pop');
    }),
    sounds,
    toggle(t('Browser notification when an agent needs you (tab in the background)'), a.browserNotifications, (v) => {
      alerts.set({ browserNotifications: v });
      if (v) void alerts.enableBrowserNotifications().then(showState);
      else showState();
    }),
    note,
  ];
}

/** The night brightness option closest to a stored value. */
function nightKey(v: number): '0.4' | '0.6' | '0.85' | '1' {
  const opts = [0.4, 0.6, 0.85, 1] as const;
  let best: (typeof opts)[number] = 0.85;
  for (const o of opts) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return String(best) as '0.4' | '0.6' | '0.85' | '1';
}

export function openSettings(root: HTMLElement, world: WorldApi, alerts?: Alerts): () => void {
  const o = world.getOptions();
  const set = (patch: Partial<WorldSettings>) => {
    world.setOptions(patch);
    prefs.set(SETTINGS_KEY, world.getOptions());
  };
  const close = () => back.remove();
  const back = modal(
    t('Settings'),
    [
      el('h3', 'ui-section', t('Theme')),
      themePicker(world, set),
      el('h3', 'ui-section', t('Office')),
      toggle(t('Show names'), o.showNames, (v) => set({ showNames: v })),
      select(t('Activity bubbles'), o.bubbles, [
        ['all', t('All')],
        ['important', t('Important only')],
        ['none', t('None')],
      ], (v) => set({ bubbles: v })),
      select(t('Idle agents wander'), o.liveliness, [
        ['calm', t('Rarely')],
        ['normal', t('Sometimes')],
        ['lively', t('Often')],
      ], (v) => set({ liveliness: v })),
      toggle(t('Camera follows the selected agent'), o.followSelected, (v) => set({ followSelected: v })),
      select(t('Characters'), o.characters, [
        ['rigged', t('Robots')],
        ['capsule', t('Simple shapes')],
      ], (v) => set({ characters: v })),
      select(t('Day and night'), o.daylight, [
        ['auto', t('Follow the local time')],
        ['day', t('Always day')],
        ['night', t('Always night')],
      ], (v) => set({ daylight: v })),
      select(t('Brightness at night'), nightKey(o.nightBrightness), [
        ['0.4', t('Dark')],
        ['0.6', t('Dim')],
        ['0.85', t('Comfortable')],
        ['1', t('As bright as day')],
      ], (v) => set({ nightBrightness: Number(v) })),
      select(t('Seasonal decorations'), o.season, [
        ['auto', t('Follow the calendar')],
        ['none', t('Off')],
        ['halloween', t('Halloween')],
        ['holiday', t('Holidays')],
      ], (v) => set({ season: v })),
      select(t('Motion'), o.motion, [
        ['auto', t('Follow the system')],
        ['reduce', t('Reduce')],
        ['full', t('Full')],
      ], (v) => set({ motion: v })),
      select(t('Graphics quality'), o.graphics, [
        ['auto', t('Automatic')],
        ['low', t('Low: no shadows')],
        ['medium', t('Medium: shadows')],
        ['high', t('High: sharper shadows')],
      ], (v) => {
        set({ graphics: v });
        // the renderer is set up once: a new quality needs a fresh page
        location.reload();
      }),
      select(t('Walls in front'), o.cutaway, [
        ['cut', t('Cut down')],
        ['hide', t('Hidden')],
      ], (v) => set({ cutaway: v })),
      ...(alerts ? [el('h3', 'ui-section', t('Sounds and notifications')), ...alertSettings(alerts)] : []),
    ],
    close,
  );
  root.append(back);
  return close;
}

const KEYS: [string, string][] = [
  ['Drag', 'Move around'],
  ['Wheel / pinch', 'Zoom'],
  ['Right-drag, Q / E', 'Turn by 90°'],
  ['W A S D, arrows', 'Move the camera'],
  ['+ / −', 'Zoom in / out'],
  ['F', 'Frame the whole office'],
  ['Click', 'Select an agent or a room'],
  ['Esc', 'Clear the selection, close dialogs'],
  ['/', 'Search agents and rooms'],
  ['N', 'Names on / off'],
  ['B', 'Cycle bubbles: all, important, none'],
  [',', 'Settings'],
  ['?', 'This help'],
];

export function openHelp(root: HTMLElement): () => void {
  const grid = el('div', 'ui-keys');
  for (const [k, what] of KEYS) {
    const keys = el('span');
    const alts = k.length > 1 ? k.split(/\s*,\s*/) : [k];
    alts.forEach((alt, i) => {
      if (i) keys.append(' ');
      keys.append(el('kbd', '', alt));
    });
    grid.append(keys, el('span', '', t(what)));
  }
  const intro = el(
    'p',
    '',
    t('Each project with an open session is a room. Each agent sits and types while it works, raises a hand when it needs you, and wanders off when idle. Subagents carry their result to their parent before leaving.'),
  );
  intro.style.fontSize = '13px';
  const close = () => back.remove();
  const back = modal(t('Help'), [intro, grid], close);
  root.append(back);
  return close;
}
