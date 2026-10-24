// The panels over the 3D office (P2-09/P2-10): top bar, sidebar, details drawer, feed, toasts, tooltip, settings,
// help and keyboard shortcuts. Keeps the camera's free area in line with what the panels cover.
import type { OfficeStore } from '../net/store';
import type { WorldApi, WorldSettings } from '../render3d/world';
import { Alerts } from './alerts';
import { openHelp, openSettings, SETTINGS_KEY } from './dialogs';
import { prefs } from './dom';
import { createDrawer } from './drawer';
import { createFeed, createHoverTip, createToasts, createTopbar } from './panels';
import { createRequests } from './requests';
import { createSidebar } from './sidebar';
import './ui.css';

/** Saved world settings (names, bubbles, liveliness, follow, cutaway). */
export function savedSettings(defaults: WorldSettings): WorldSettings {
  return prefs.get(SETTINGS_KEY, defaults);
}

export function createUI(root: HTMLElement, store: OfficeStore, world: WorldApi): void {
  const alerts = new Alerts(store, world);
  let closeDialog: (() => void) | null = null;
  const dialog = (open: () => () => void) => {
    closeDialog?.();
    const close = open();
    closeDialog = () => {
      close();
      closeDialog = null;
    };
  };
  const topbar = createTopbar(store, world, {
    settings: () => dialog(() => openSettings(root, world, alerts)),
    help: () => dialog(() => openHelp(root)),
  });
  const sidebar = createSidebar(store, world);
  const drawer = createDrawer(store, world);
  root.append(topbar, sidebar.el, createFeed(store, world), drawer.el, createRequests(store, world), createToasts(store, world), createHoverTip(store, world));

  const insets = () => {
    const narrow = innerWidth < 760;
    world.setViewInsets({ top: 64, left: narrow ? 0 : sidebar.width(), right: narrow ? 0 : drawer.width(), bottom: 0 });
  };
  world.onSelect(() => requestAnimationFrame(insets));
  addEventListener('resize', insets);
  insets();

  addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (e.key === 'Escape') {
      if (closeDialog) closeDialog();
      else world.select(null);
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const save = () => prefs.set(SETTINGS_KEY, world.getOptions());
    switch (e.key) {
      case '/':
        e.preventDefault();
        sidebar.focusSearch();
        break;
      case '?':
        dialog(() => openHelp(root));
        break;
      case ',':
        dialog(() => openSettings(root, world, alerts));
        break;
      case 'n':
        world.setOptions({ showNames: !world.getOptions().showNames });
        save();
        break;
      case 'b': {
        const order = ['all', 'important', 'none'] as const;
        const cur = order.indexOf(world.getOptions().bubbles);
        world.setOptions({ bubbles: order[(cur + 1) % order.length]! });
        save();
        break;
      }
      default:
        // camera keys (Q/E, WASD, arrows, +/−, F) work even when the canvas isn't focused
        if (document.activeElement !== document.getElementById('world') && /^(q|e|w|a|s|d|f|\+|=|-|Arrow\w+)$/.test(e.key)) {
          document.getElementById('world')?.dispatchEvent(new KeyboardEvent('keydown', { key: e.key }));
        }
    }
  });
}
