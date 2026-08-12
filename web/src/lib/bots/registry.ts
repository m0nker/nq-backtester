// Bot registry — the menu of strategy bots offered at session creation.
// A session's config stores { mode: 'bot', botId }; legacy bot sessions
// (created before the registry) have mode 'bot' with no botId and resolve
// to the FVG strategy. Adding a bot = adding an entry here plus wiring its
// engine in botStore (revised 2026-08-12: two engines now — the FVG
// condition/arming path, and the DOL sweep path shared by 'mech-model' and
// 'mech-2'; botStore's `isDolBot` is what routes between them).

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
  {
    id: 'mech-2',
    name: 'Mech 2',
    description:
      "The FVG strategy's execution with a swept draw on liquidity as the condition: only sweeps at/after 09:30 ET of the current trading day arm, and the sweep side sets the direction (sellside → longs, buyside → shorts; no bias). IFVG trigger across every enabled timeframe with the same filled-gap veto. No inversion deadline — an armed sweep dies only when price strays past the distance you set from the level.",
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
