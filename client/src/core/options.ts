// Ported from habblaud client/src/world/api.ts (MIT, © 2026 Márcio Junior): the world options the sim and the
// renderer read. The rest of Habblaud's WorldApi (social, timelapse, World city) isn't ported.

export interface WorldOptions {
  /** Show name labels above characters. */
  showNames: boolean;
  /** Activity bubbles: all, important only (needs you, selected, recent changes) or none. */
  bubbles: 'all' | 'important' | 'none';
  /** How often idle agents wander around the office. */
  liveliness: 'calm' | 'normal' | 'lively';
  /** The camera follows the selected agent. */
  followSelected: boolean;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  showNames: true,
  bubbles: 'important',
  liveliness: 'normal',
  followSelected: false,
};
