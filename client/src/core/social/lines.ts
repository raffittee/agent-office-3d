// What people say during gatherings (P6-01): short, light, about work and games. Picked by the gathering's seed so
// every browser shows the same scene.
import type { GatherKind } from './gathering';

export const OPENERS: Readonly<Record<GatherKind, readonly string[]>> = {
  tv: ['Anything good on?', 'Five minutes, then back to work.', 'Is this the one with the robots?'],
  pingpong: ['Best of five?', 'Prepare to lose!', 'Loser buys coffee.'],
  arcade: ['One round!', 'I know the secret level.', 'You’re going down.'],
  kitchen: ['Fresh coffee?', 'How’s your sprint going?', 'Did you see the new build?'],
  talk: ['Got a minute?', 'Quick question…', 'Hey, about that bug…'],
  rps: ['Rock, paper, scissors for the review?', 'Loser fixes the flaky test!', 'Best of three!'],
};

export const CHATTER: Readonly<Record<GatherKind, readonly string[]>> = {
  tv: ['Ha!', 'No way!', 'Plot twist!', 'Shh, this part is good.', 'I called it.'],
  pingpong: ['Nice shot!', 'Lucky!', 'Spin!', 'Out!', 'Net!'],
  arcade: ['Combo!', 'Come on…', 'Boss level!', 'Extra life!'],
  kitchen: ['Tabs or spaces?', 'Merged it this morning.', 'The tests are green.', 'Try the new beans.', 'Rebase or merge?', 'It was a cache issue.'],
  talk: ['Makes sense.', 'Ship it.', 'Let’s pair on it.', 'Did you check the logs?', 'Good idea!'],
  rps: ['Again!', 'Tie!', 'Hmm…'],
};

export const WIN = ['Winner!', 'GG!', 'Too easy.', 'Yes!'];
export const LOSE = ['Rematch!', 'Next time…', 'GG.', 'Argh.'];
export const BYE = ['Back to work!', 'That was fun.', 'Let’s do this later.', 'Right, the PR.'];

export function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}
