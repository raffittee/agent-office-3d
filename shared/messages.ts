// Ported from habblaud shared/messages.ts (MIT, © 2026 Márcio Junior)
// Messages from the office (P7-04, POST /api/messages): what the server and the page share. Pure.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { t } from './i18n';

/** Longest message (characters). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` of the "Message from the office" activity (your text going in, not a tool of the agent). */
export const MESSAGE_TOOL = 'OfficeMessage';
const DETAIL_MAX = 300;

/** The activity of a message delivered to the session (in it or in its queue: not yet read by the agent). */
export function describeMessage(text: string): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  return { kind: 'communicate', icon: '✉️', text: t('Message from the office'), tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}
