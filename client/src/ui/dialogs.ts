// Settings (the theme picker, P4-09, and the world options) and the help/shortcuts dialog (P2-10).
import { t } from '../../../shared/i18n';
import type { WorldApi, WorldSettings } from '../render3d/world';
import { themes, type ThemeEntry } from '../themes/registry';
import { button, el, prefs } from './dom';

export const SETTINGS_KEY = 'world';

function modal(title: string, body: HTMLElement[], onClose: () => void): HTMLElement {
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

export function openSettings(root: HTMLElement, world: WorldApi): () => void {
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
      select(t('Walls in front'), o.cutaway, [
        ['cut', t('Cut down')],
        ['hide', t('Hidden')],
      ], (v) => set({ cutaway: v })),
      el('p', 'ui-empty', t('More settings (sounds, notifications) arrive in later phases.')),
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
