// Bot registry — the menu of strategy bots offered at session creation.
// A session's config stores { mode: 'bot', botId }; legacy bot sessions
// (created before the registry) have mode 'bot' with no botId and resolve
// to the FVG strategy. Adding a bot = adding an entry here plus wiring its
// engine in botStore (today all ids run the FVG engine).

export interface BotDef {
  id: string;
  name: string;
  description: string;
}

export const BOTS: BotDef[] = [
  {
    id: 'fvg-strategy',
    name: 'FVG Strategy',
    description:
      'Condition FVG + IFVG trigger engine (STRATEGY_DEFINITIONS.md). Set a bias, get prompted at setup candidates — or let it auto-trade. Risk, window and action are configured in the in-session BOT panel.',
  },
  {
    id: 'mech-model',
    name: 'Mech Model',
    description:
      'Draws on liquidity: session H/L (Asia, London, NY AM/PM), previous day/week H/L and HTF swings. Sweeping sellside arms longs, buyside arms shorts; same IFVG trigger entry. Armed sweeps invalidate when price strays too far from the level (distance set in the BOT panel).',
  },
];

export function botById(id: unknown): BotDef | null {
  return BOTS.find((b) => b.id === id) ?? null;
}

// Which bot a session's config refers to (null = manual session).
export function botOfConfig(config: Record<string, unknown> | undefined | null): BotDef | null {
  if (!config || config.mode !== 'bot') return null;
  return botById(config.botId) ?? BOTS[0]; // legacy bot sessions predate botId
}
