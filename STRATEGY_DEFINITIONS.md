# Strategy Definitions (v1) — Bias + 3 Core Execution Rules

This document is the **spec** for the mechanical perception/candidate engine. Code must match this
doc; when a rule changes, change it here first. Definitions were locked in conversation on
2026-07-29. Anything marked **[v1 default]** was chosen by Claude as a reasonable starting point and
is explicitly up for revision.

Instrument scope: **NQ only** (ES stays chart-only). All prices are the chart's **back-adjusted
continuous** prices — bias levels are entered against the chart during replay, so everything is
internally consistent.

---

## 1. Bias

Bias is **human input**, entered in the UI during replay and recorded as append-only events
(`bias_set` / `bias_removed`), same as every other session action — rewind-safe, and it accrues as
training data for the eventual bias model.

Bias is a **list** of independent entries (locked 2026-07-30):

```
bias entry = { direction: 'long' | 'short', until: price }
```

- The trader can hold **one or several** entries at once, including both directions ("bullish
  until 26000" + "bearish until 24000" → the engine hunts both ways).
- Empty list → the engine is **dormant**. No candidates, in either direction.
- **Reset ("until" semantics):** each entry points *toward* its `until` (the draw, not an
  invalidation) and **dies independently** the moment price touches its level (locked:
  independent lifetimes):
  - long entry: some visible bar's `high >= until`
  - short entry: some visible bar's `low <= until`
  - **[v1 default]** a touch (wick) counts — price does not need to trade through. Only bars
    opened at/after the entry was set count.
  - Death is **derived from bars** (like rewind voiding) — no event is written for it.
- **Reset affects new entries only** (locked): a dying bias blocks new candidates; an open
  position keeps running on its own SL/TP.
- Rule-1 alignment is checked **at the confirmation close**: a candidate needs a live,
  matching-direction entry at that moment. Condition-FVG *arming* (rule 2) is bias-independent —
  bias only gates the candidate itself — but the arming tap must be **in-session** (see rule 2's
  session-tap rule).
- The engine never infers, flips, or removes bias on its own.

### Daily bot workflow (locked 2026-07-30)

In a **bot session**: "Next day" jumps to the next trading day's **09:25 ET** → the trader enters
the day's bias list → presses play → the engine pauses at each candidate with the labeling prompt.
Bias entries persist across days until hit or removed. Candidates that would fire inside a
jumped-over span are logged but auto-skipped (`decision: skip`, noted) in prompt modes.

---

## 2. Fair Value Gap (FVG)

### 2.1 Anatomy

Three **consecutive candles** `A`, `B`, `C` on a single timeframe:

- **Bullish FVG:** `C.low > A.high`. The zone is `[A.high, C.low]`
  (bottom = `A.high`, top = `C.low`).
- **Bearish FVG:** `C.high < A.low`. The zone is `[C.high, A.low]`
  (bottom = `C.high`, top = `A.low`).
- **CE (consequent encroachment)** = the zone midpoint, `(top + bottom) / 2`.
- The FVG **exists only once candle `C` closes** on its own timeframe (epoch `C.t + tfSec`). A
  forming partial candle can show a gap that vanishes by close — partial candles never create FVGs
  (no lookahead).
- **No minimum size and no displacement filter** in v1. Every 3-candle gap counts; quality filters
  come later as confluences.

### 2.2 Timeframe sets

- **Condition FVGs (rule 2 taps):** 5m, 15m, 30m, 1h, 4h
- **Trigger IFVGs (rule 3 entries):** 15s, 30s, 1m, 2m, 3m, 4m, 5m — 15s/30s only exist where
  the dataset has 1-second coverage (NQ ≈ Mar 2025 onward); elsewhere they are silently skipped.
- **V1 scope (locked 2026-07-30):** the live trigger scan runs on **1m only**. The full design —
  scan every trigger TF and select the **highest-timeframe IFVG** — is deferred; the engine takes
  its trigger-TF list as configuration so this is a list change plus a selection rule, not a
  rearchitecture.

(5m appears in both sets on purpose.)

### 2.3 Lifecycle

State transitions are evaluated against **visible bars only** (replay-clock-clipped), using
base-resolution bars for touch timing and own-timeframe closes for inversion.

Every gap is in exactly one of three states (user's vocabulary, locked 2026-07-30) — until it
expires (below):

| State | Definition |
|---|---|
| **Unfilled** | Never tapped: no bar has traded **strictly inside** the zone. An exact touch of the boundary (`low == top`) is **not** a tap (locked: "trade inside the gap"). |
| **Filled** | Tapped at least once: some bar traded strictly inside (`bar.low < top AND bar.high > bottom`), at any depth. Depth is tracked as **fill %** — deepest penetration, `(top − minLowSinceFormed) / (top − bottom)` for bullish (mirror for bearish), clamped 0–100% — but even a full wick-through does **NOT** kill the gap (locked: "alive until inverted"). |
| **Inverted** | A candle **on the FVG's own timeframe** closes **strictly beyond the far edge**: bullish FVG → `close < bottom`; bearish FVG → `close > top`. Terminal state for the original direction. |

**Fully mitigated (locked 2026-07-30):** when price has traded through the **entire** gap —
the fill watermark reaches the far edge — the gap is *fully mitigated*. Example: bullish 1h gap
25800–26000; the next candle prints OHLC 26100 / 26200 / **25700** / 26100 → its low traded
through the whole zone → fully mitigated. A fully mitigated gap **can never arm or re-arm as a
condition FVG**, even though it is not inverted — and the traversing candle itself does NOT count
as an arming tap (it spent the gap on its way through). If the gap was armed, full mitigation
**disarms** it. This refines the earlier "alive until inverted": a mitigated gap stays alive for
*inversion* purposes (rule-3 triggers routinely sweep fully through before closing through, and
it still blocks lower-TF triggers in the overlap hierarchy) but is dead as a condition.

**Expiry (locked 2026-07-30):** a gap is only considered for **25 candles of its own timeframe**
after formation. Age = series positions since candle `C` (the forming partial candle counts as a
position); the gap is valid while age ≤ 25 and expires when a 26th candle exists. Expiry is
terminal: an expired gap is not a PD array, is not rendered, and **can no longer invert** — its
prints stop counting for anything. Each timeframe ages in its own candles (25 × 15m ≈ 6¼ hours,
25 × 4h ≈ 4 trading days).

### 2.4 Inversion FVG (IFVG)

An **IFVG is an inverted FVG with its polarity flipped**, same zone boundaries:

- Bearish FVG + a close **above** its top → **bullish IFVG** (expected support).
- Bullish FVG + a close **below** its bottom → **bearish IFVG** (expected resistance).

The candle whose close performs the inversion is the **confirmation candle**; the inversion is
known at that candle's close time, never earlier.

---

## 3. The three core rules → a candidate

Long template below; shorts are the exact mirror.

### Rule 1 — Bias alignment
A live **long** bias entry exists at the confirmation close. Empty bias list → no candidates.

### Rule 2 — the condition FVG tap
Price **trades strictly inside** an **active** (never-inverted, not expired) **bullish** FVG on
5m–4h — the **condition FVG** (user's term, locked 2026-07-30).
- Tap timing is detected on base-resolution bars (1m), so we know *which minute* entered the zone.
- **Session-tap rule (locked 2026-07-30):** an arming tap only counts if it happens **at/after
  09:30 ET of the current trading day**. At 09:29 nothing is armed; premarket, overnight, and
  prior-day taps do not arm (they had made every 1m IFVG a candidate off days-old taps). A gap
  tapped out-of-session arms on its next fresh in-session print; crossing into a new trading day
  stales every prior armed state. This supersedes the earlier premarket-taps-count default.
- **Fill-watermark rule (locked 2026-07-30):** every gap carries a **watermark** — the deepest
  price ever traded into it since formation, any session (a bearish gap fills upward from its
  bottom edge, bullish mirror). An arming print must go **strictly beyond** the watermark as of
  just before that bar — into the *unfilled remainder* — not merely back inside the zone. Every
  penetrating print advances the watermark whether or not it arms. A fully filled gap has no
  remainder and can never arm. Example (the motivating case): bearish 1h gap 25500–26000, an 8am
  candle pushes to 25700 → watermark 25700; at 09:30+ a print at 25600 does **not** arm — price
  must print above 25700.
- The tap **arms** the setup. It stays armed until one of (locked):
  1. the condition FVG **inverts** (own-TF close through it) — "stop looking when the condition
     FVG is inversed",
  2. the condition FVG **expires** (25 own-TF candles — expiry disarms, locked 2026-07-30),
  3. the condition FVG becomes **fully mitigated** (price traded through the whole zone — disarms
     and blocks re-arming forever, locked 2026-07-30),
  4. **the leg extreme is taken** (locked 2026-07-30, from the user's illustrations): at arming,
     the setup records its invalidation reference — for a bear condition the **lowest low printed
     from the gap's candle A through the arming tap** (the low the retrace departed from; mirror:
     highest high for bull). ANY print strictly beyond it — **a wick counts**, no close needed —
     disarms: the move the setup was hunting already ran without a trigger. Unlike full
     mitigation this is NOT terminal: a later fresh in-session beyond-watermark tap **re-arms
     with a new reference** (arm → low taken → unarm → deeper re-tap → re-arm → new low taken →
     unarm, per the two-cycle drawing). This kills the far-away-condition failure (a 5m bear gap
     tapped at 09:56 lending its arm to a 1m trigger 290 points lower at 10:50),
  5. the trading day ends (the session-tap rule above — armed never survives to the next day),
  6. **a trade is taken in its direction** (locked 2026-07-30): a long execution unarms **every**
     bullish armed gap, a short unarms every bearish one — including in-batch and queued
     candidates of that direction. Watermarks are untouched, so any of them can **re-arm** on a
     fresh in-session print beyond its watermark (user-confirmed). A label-only "take" counts as
     a taken trade for this rule, keeping the candidate stream identical across modes.
- The stop's swing scan starts at the (in-session) primary tap, so stops are anchored to the
  session's retracement, not an overnight range.
- **[v1 default]** taps are side-agnostic: any print strictly inside an active gap arms it.

### Rule 3 — trigger IFVG in the opposite direction
While armed: a **bearish** FVG on a trigger timeframe becomes a **bullish IFVG** — a candle on its
own timeframe **closes above the gap's top** — with the confirmation close occurring **at or after
the tap** and while the condition FVG is still alive.

- **Trigger scan = all seven TFs, 15s–5m** (upgraded from the 1m-only v1, locked 2026-07-30),
  governed by the **overlap hierarchy** below. (15s/30s participate only where 1s data exists.)
  Each TF is individually toggleable in the bot settings; a disabled TF is not considered at
  all — neither as a trigger nor as an overlap blocker. At least one stays enabled.
- **Filled-gap veto (locked 2026-07-30; tightened same day — overlap NOT required):** the
  execution belongs to the *highest timeframe* still in play. An inversion on TF X is
  **suppressed** when **any** same-direction, active gap on a **same-or-higher** trigger TF is
  in **filled** status (tapped, not yet inverted) at the confirmation — regardless of whether the
  zones overlap (an adjacent-but-not-intersecting filled 2m above a 1m trigger vetoes it, per the
  observed failure case). Details:
  - only *filled* gaps block — an untapped higher gap is not yet in play;
  - *lower* TFs never block (a still-filled 4m can't veto a 5m close — bucket close-time
    differences make this the normal case);
  - same-TF filled gaps DO block (two consecutive 1m gaps: one filled vetoes the other's
    inversion);
  - a suppressed inversion is consumed — if the bigger gap never inverts, no trade comes from it.
    True "leg" detection (highest-TF IFVG *of the leg*) is future discretionary work; this veto
    is its mechanical stand-in.
- Eligible bearish trigger FVGs are the **active** ones — not inverted and within their 25-candle
  life. **[v1 default]** no further location filter (where the gap formed relative to the
  condition zone is a future confluence).
- If several trigger TFs confirm on the same close time, that is **one** candidate; the **highest
  timeframe** IFVG is the reference.
- If several condition FVGs are armed when a trigger fires, that is **one** candidate; the
  **highest-TF** condition is primary (its tap anchors the stop's swing scan) and the others are
  recorded on the candidate.
- **Dedup:** one IFVG fires at most **one** candidate, ever. Each *new* inversion while armed fires
  a new candidate.

### Time window
The confirmation close must land inside the session's **trading window** — a per-session setting
on the bot-session form (ET start/end, inclusive of the end), defaulting to the locked
**09:30–11:00 ET**.

### Execution (locked)
| Leg | Rule |
|---|---|
| **Entry** | Market on confirmation: filled at the **next base bar's open** after the inversion close (matches the existing fill simulator's market rule). |
| **Stop** | **Retracement swing low**: the lowest low (base-resolution) from the **tap bar** through the **confirmation close**. Tick buffer configurable, **[v1 default]** 0. |
| **Target** | **1R**: `target = entry + (entry − stop)` for longs. |

A candidate is recorded as a `candidate_shown` event:
```
{ candidateId, direction, confirmTs, condition (tf, zone, formed, armedAt),
  otherConditions, ifvg (tf, zone, formed), stop, entryEst, biasId }
```
followed by a `decision_made` event `{ candidateId, decision, notes? }`.

---

## 3b. Session modes & the candidate prompt (locked 2026-07-30)

Session creation has a single **Bot checkbox** (config `mode: 'bot' | 'manual'`). Everything else
about the bot is configured **in-session** via the BOT panel on the trading screen — bias entry,
active-time window, candidate action, risk sizing, window-hopping — editable live; changes persist
to localStorage (defaults for new sessions) and to the session's config (survives resume).

- **Manual** — the original backtester; the strategy engine is off.
- **Bot** — the engine runs, with a **candidate action**:
  1. **Prompt & trade** — replay pauses at each candidate; the prompt's *Take* places the bracket
     (market entry, swing-extreme stop, 1R target) and *Marginal*/*Hard skip* just label.
  2. **Label only** — same prompt, but no decision ever places a trade.
  3. **Auto** — every candidate is taken mechanically, no prompt (`decision: 'auto'`) — the
     decomposition-experiment mode.

**Position sizing (locked 2026-07-30):** contracts trade in **0.1 steps** (0.1 NQ ≈ 1 MNQ),
minimum 0.1 — for manual and bot trades alike. The bot sizes each trade by its risk setting:
- **Constant contracts** — a fixed size;
- **% of balance** — risk a percentage of the **current** account balance (starting balance +
  realized P&L);
- **Fixed $** — risk a set dollar amount.
For %/$ the ideal size = risk-dollars ÷ (stop-distance-points × $20/pt), rounded to the
**nearest 0.1**. Worked example (locked): $50k account, 1% risk, 20-pt stop → $500 ÷ $400 = 1.25
→ **1.3** contracts.

**One position at a time (default ON, locked 2026-07-30):** while a trade is on — open position,
any working order, or an entry awaiting its fill — the bot does not look for candidates at all;
it resumes only when the book is completely clean. (Also prevents the cancel-out failure mode:
two opposite entries netting flat, orphaning every reduce-only leg.)

**Prompt chart marks:** while the candidate prompt is up, the exact condition FVG (amber) and
trigger IFVG (sky) are outlined on the chart, independent of the FVG indicator's toggles.

**Window hopping (opt-in):** when enabled, any time the clock sits outside the active window with
nothing running (flat, no working orders, no pending fill or prompt), the bot jumps to **one
minute before the next window open** (the "next 9:29"). A running trade keeps the clock going
until it resolves. Combined with the high autoplay speeds this makes multi-day auto backtests
practical. Speeds above ~100 bars/s advance several bars per tick — same late-fill caveat as
bucket stepping.

**Prompt form v1 (locked):** graded decision — **take / marginal / hard skip** — plus an optional
free-text notes field. The 5–8 anchored attribute sliders from the project brief come later, once
the workflow has been felt; same form will apply to takes AND skips.

**Execution mechanics:** entry is a market order at the confirmation close; once the fill price
is known the engine places an OCO pair — stop at the **absolute** swing-extreme level, limit at
**fill + 1R** (1R measured fill→stop). If price gapped through the stop before the fill, no legs
are placed (flagged for manual handling).

**Fill resolution (locked 2026-07-30):** fill granularity follows the **step size**. When
stepping a sub-minute size (**1s / 15s / 30s**) and the day has 1-second coverage, fills simulate
on **1s bars** — a market order fills at the *next second's* open and limit/stop touches resolve
at 1s precision. Minute-or-larger stepping and autoplay keep the fast 1-minute fill model with
its 1s same-bar SL/TP sequencing (the seconds walk made minute stepping laggy). A **1s step
size** exists in the replay controls (one raw second bar per step; no 1s chart timeframe).

**Fast-forward fidelity:** detection scans the full range of every clock advance, so no candidate
is ever *missed* — but entry orders are placed at the advance's **end**. Under 1m autoplay (any
speed, incl. the 50/100 bars-per-second settings) that is the confirmation close, so fills are
exact. Stepping in bigger buckets (5m/15m/…) or day-jumping places entries late (at the bucket
end / jump end) — fine for browsing, not for a faithful auto backtest; run those on 1m autoplay.

---

## 4. Out of scope for v1 (deliberately)

- Additional confluences (displacement, liquidity sweeps, session/prior-day levels, draw quality,
  unfilled 5m/15m gap conditions) — these become features/attributes later, not gates now.
- Breakeven / trade-management discretion.
- ~~Auto-trading~~ — superseded 2026-07-30: bot sessions support prompt-&-trade, label-only, and
  full-auto candidate actions (§3b).
- Bias inference of any kind.

## 5. Open questions parked for later

1. Bias reset on **touch** vs **trade-through** of `until` — currently touch.
2. ~~Recency filter for eligible gaps~~ — **resolved 2026-07-30**: every FVG lives 25 candles of
   its own timeframe (see §2.3 Expiry). A during-the-retrace-leg location filter may still come
   later as a confluence.
3. Whether a second tap of the *same* HTF gap after a failed candidate should re-arm immediately —
   currently yes (gap stays valid until inverted or expired).
5. **"Only one armed condition per timeframe"** — raised 2026-07-30 but deliberately deferred
   (the user wants to feel the session-tap rule first); today every in-session-tapped active gap
   arms, and a trigger matching several conditions still fires one candidate with the highest-TF
   condition as primary.
4. 30s IFVGs (brief mentions them) — possible only where 1s data exists; excluded from v1.

---

## 6. The Mech Model (revised 2026-08-12)

A **second bot**, selectable at session creation (`mech-model`), sharing the trigger machinery of
§3 but replacing rules 1–2 entirely. Everything in §3b (session modes, sizing, one-position gate,
prompt, fill fidelity) applies unchanged.

### 6.1 Theory

The model catches the **rebalance after a high-timeframe draw on liquidity is hit** — *not* a full
reversal. Price runs a significant pool (a session/PD/PW high or low, or an HTF swing), the
liquidity is taken, and the move back into the range is the trade. Consequences the rules encode:

- the **sweep is the directional read** — there is no bias input at all (rule 1 does not exist
  here); sweeping **sellside** (a low) hunts **longs**, **buyside** (a high) hunts **shorts**;
- targets are **near**, and **runners are not the default** — without a clear reason for
  continuation the trade is a rebalance, so the exit is the nearest **unfilled 5m/15m gap** the
  move can rebalance into (§6.3, user spec 2026-08-12; this supersedes the 1R exit of §3 for both
  mech bots);
- a rebalance is a *short-lived* opportunity: an armed sweep that produces no trigger inside its
  deadline is not tradeable later at the same price (see the timers below).

### 6.2 Entry rules

**Condition — a sweep of significant liquidity.** The level catalog is 9 toggleable categories:
session H/L for Asia (20:00–24:00 ET), London (02:00–05:00), NY AM (09:30–11:00), NY PM
(13:00–16:00) — each the most recent **completed** window; previous trading **day** and **week**
H/L; and confirmed 5-bar-fractal swing H/L on 1h / 4h / 1D that aren't already one of the above.

- A **qualifying raid** is a print strictly beyond the level's watermark (its deepest prior
  excursion) whose **raid extreme** is within the configurable **invalidation distance**
  (default 40 pts) of the level. Judging the raid extreme alone, rather than the bar's whole
  range, keeps a wide reversal candle — exactly the shape this model wants — from invalidating
  its own sweep.
- **Every qualifying raid inside the resweep window (re)arms the level (revised 2026-08-12,
  supersedes the 2026-08-01 "arms once, death is terminal" lock).** This is deliberately the
  **same resweep semantics as the FVG model's condition tap** (§3 rule 2 / the 2026-08-06 resweep
  lock): a deeper raid means the raid the bot was trading is stale, so
  - `sweptAt` moves to the new raid and the inversion deadline **restarts**,
  - any prior death is **erased** — a re-swept level comes back,
  - the trigger gaps that were in play are **staled**: the resweep **retires the blockers** of the
    direction the sweep arms (a sellside resweep retires the *bear* blockers, since longs come
    from bear gaps inverting). A retired blocker vetoes again only once price drives **deeper**
    into it than it had been filled when it was cleared — identical to the FVG model's rule.
    **A resweep retires only the vetoes that were standing BEFORE it (user decision
    2026-08-12).** The retirement mark is the blocker's penetration as of the moment the resweep
    bar opens, and a penetration deeper than that **at or after** the resweep bar re-establishes
    the veto — *including on the resweep bar itself and inside the same advance*. This fixes the
    reported case where one candle simultaneously reswept a draw, tapped deeper into a standing
    blocker and inverted a trigger: the clear used to be marked at the end-of-advance penetration,
    which swallowed the candle's own fresh tap and let the trigger fire.
- **Resweep validity window (added 2026-08-12, user spec).** Resweeps are valid only within a
  configurable countdown (**default 30 min**) that starts at the level's **FIRST** qualifying raid
  — anchored there, **not** at the latest re-arm, so a chain of deeper raids cannot walk the
  window forward indefinitely. Once it passes, **the level is no longer a valid DOL** for this
  cycle: a deeper raid still deepens the watermark (a breakout must always be able to retire the
  level) but **cannot re-arm** it, and whatever arming is already standing just lives out its
  normal deaths. A raid at exactly first-sweep + window still counts (inclusive boundary).
- **Three deaths** of an armed sweep:

  | Death | Rule |
  |---|---|
  | **Timer (per trigger TF)** | the inversion must land within `maxCandles` candles **of that trigger's own timeframe** after the sweep (default 6 → 6m on 1m, 30m on 5m). |
  | **Minute cap** | an absolute ceiling from the sweep (default 20 min) overriding the per-TF timer wherever it is shorter — 6 candles + 20 min gives 5m only 4 candles, while 3m is untouched (6×3 < 20). |
  | **Distance** | price trading farther than the invalidation distance from the level in either direction — beyond it (the raid became a breakout) or away from it (the move ran without a trigger). |

  A death is **not terminal**: it stands only until the next qualifying raid *inside the resweep
  window*. The one permanent exit is a **breakout** — once the watermark sits more than the
  invalidation distance past the level, no deeper raid can ever qualify again. (The leg that swept the level can of course become
  a **new** level once it confirms as a swing; that is a different level with its own identity.)
- Distance and timer checks only consider bars **after** the arming bar, so the sweep candle's own
  excursion cannot kill the state it just created.
- A **taken trade** retires every armed sweep of that side (mirror of §3 rule 2's rule 6) — the
  *raid* is spent, not the level: a later deeper qualifying raid re-arms it, exactly as the FVG
  model's untouched watermarks let a condition re-arm after a trade.

**Trigger — the highest-TF IFVG in the leg.** Scanned on **5m, 4m, 3m, 2m, 1m** only (no
sub-minute TFs for this model; the per-TF toggles still apply, narrowed to this set). An IFVG
inversion confirms against an armed sweep of the **aligned** side whose per-TF deadline has not
passed, with the confirmation close inside the **execution window** (§3 "Time window", same
per-session setting).

- "Highest-TF IFVG **of the leg**" is enforced mechanically by the **filled-gap veto** of §3 rule
  3 — an inversion on TF X is suppressed while any same-direction, active, *filled* gap on a
  same-or-higher trigger TF is still in play — plus the **cleared-blocker** rule above, so a
  resweep restarts the hierarchy instead of leaving the leg's old blockers standing forever.
- When several TFs confirm on the same close, the **higher timeframe** is the reference
  (candidates are ordered confirmation-time ascending, then trigger TF descending).
- **Dedup** is per IFVG, as in §3.
- **Which swept draw the candidate anchors on (revised 2026-08-12, supersedes "the most recent
  raid"):** when several armed sweeps of the aligned side qualify for the same inversion, the
  **most extreme** one is the play — the **highest** level price for shorts (buyside), the
  **lowest** for longs (sellside). A leg that ran through LDN H into PDH is a raid on **PDH**,
  whether the two were taken on the same bar or in sequence (sweep the London low, then take PDL
  below it with no trigger in between → PDL is the condition). The choice is made **only among
  the sweeps that already qualified** on side, timing, deadline and (Mech 2) session, so a dead
  or out-of-deadline extreme level never wins.
- **Stop** = the **raid extreme**: lowest low (long) / highest high (short) from the **chosen
  draw's** sweep bar through the confirmation, including the sweep wick itself. **Target** = the
  unfilled 5m/15m gap edge of §6.3 — **required**: no valid target, no candidate.
- Diagnostics: every considered inversion records an outcome — `candidate`, `duplicate`,
  `window`, `vetoed` (with the blocking TF), **`no-sweep`** (no armed sweep of the aligned side
  inside its deadline — this model's stand-in for `no-bias`/`no-condition`), **`no-target`** (no
  unfilled 5m/15m gap to rebalance into, §6.3), or `geometry` — and the bot scope panel shows the
  latest per timeframe.

### 6.3 Target — an unfilled 5m/15m FVG (user spec 2026-08-12)

**A mech candidate REQUIRES a target.** Both mech bots take the rebalance *toward* an **UNFILLED**
5m or 15m FVG of the **opposite polarity**: longs need a **bearish** one, shorts a **bullish** one.
This replaces the 1R target of §6.2 / §3 "Execution" for these bots — the FVG strategy keeps 1R.

- **Unfilled is absolute.** The gap must never have been tapped — *no print inside it, ever*. Any
  mitigation (or inversion, or expiry) disqualifies it: a filled gap is spent liquidity, not a draw.
- **TP = the gap's NEAR edge** — the **bottom** of the bearish gap for a long, the **top** of the
  bullish gap for a short. It is an **absolute price**, not an R multiple.
- **Closest valid edge wins**, across both timeframes: if the nearest 5m bottom is closer to the
  entry than the nearest 15m bottom, the 5m is the target; two 5m gaps in a row → the closer one.
- The edge must be on the **profit side** of the entry (bottom > entry for longs, top < entry for
  shorts); an edge at or past the entry does not qualify.
- **Age window.** The gap must have **formed** within `targetGapMaxAgeMinutes` (**default 60**, per
  bot setting, both mech bots) of the confirmation: `formedAt >= confirmTs - X*60`.
- **No valid target → no candidate.** The rejection is reported as **`no-target`** in the
  diagnostics and on the bot scope panel, which also shows the current closest valid target per
  side (timeframe, edge price, age) so the gate is visible before a trigger fires.
- Implementation note: target trades use the fully absolute bracket form (`stopPrice` +
  `tpPrice`), so the TP limit sits exactly AT the gap edge regardless of the entry fill. An entry
  that gaps through the edge exits at the next bar — the target was reached.

### 6.3b Deferred, not implemented

- Runner management / continuation reasons: out of scope, same as §3's trade-management line.
- **Rewind caveat (implementation, not spec):** cleared-blocker state is not reconstructed on
  rewind for this model — the resweeps that retired blockers aren't replayed, so blockers resume
  standing. Conservative by choice: after a rewind the bot vetoes rather than over-fires.

---

## 7. Mech 2 (added 2026-08-12)

A **third bot** (`mech-2`), selectable at session creation. It is the **FVG strategy's execution
with the condition swapped**: everything §3 rule 3 does — trigger scan, filled-gap veto,
cleared-blocker resweep rule, dedup, stop/target geometry, execution window — is unchanged, and
the thing that has to be true before a trigger counts is a **swept draw on liquidity** instead of
a tapped condition FVG. §3b (session modes, sizing, one-position gate, prompt, fill fidelity)
applies unchanged. It shares the level catalog, sweep/re-sweep machinery and the "spent raid"
rule of §6.2 — read that section first; what follows is only where Mech 2 differs.

### 7.1 What it takes from the Mech Model

- The **level catalog** (9 toggleable categories) and the **qualifying raid** definition: a print
  strictly beyond the level's watermark whose raid extreme is within the invalidation distance.
- **Every qualifying raid (re)arms**, `sweptAt` moves to the new raid, any prior death is erased,
  and the **resweep retires the blockers** of the direction the sweep arms — the same
  cleared-blocker bookkeeping as the FVG model, so a retired blocker vetoes again only once price
  drives deeper into it than it had been filled when it was cleared.
- The **resweep validity window** (added 2026-08-12, default 30 min from the level's **first**
  qualifying raid). This is **not** one of the timers §7.2 removes — it dates the *level* as a
  draw, not the trigger — so Mech 2 honours it in full: past the window a deeper raid only
  deepens the watermark and the level is no longer a valid DOL. With no timer to kill it, an
  arming already standing when the window closes simply stays armed until the distance rule
  takes it.
- **The most extreme swept draw of the aligned side is the play** — highest level price for
  shorts, lowest for longs — chosen among the sweeps that already qualified (§6.2 trigger rules).
- **Direction comes from the sweep side** — sellside (a low) hunts **longs**, buyside (a high)
  hunts **shorts**. There is **no bias input** (rule 1 does not exist here either).
- A **taken trade** retires every armed sweep of that side; the level survives and a later deeper
  qualifying raid re-arms it.
- **Stop** = the raid extreme from the sweep bar through the confirmation (including the sweep
  wick); **target** = the unfilled 5m/15m gap edge of §6.3 (required — no target, no trade).

### 7.2 What is different

- **In-session arming (the FVG bot's session-tap rule, applied to the sweep).** Only a raid at or
  after **09:30 ET of the confirmation's trading day** can back a candidate — an overnight or
  premarket sweep is not tradeable, exactly as an overnight condition tap does not arm (§3 rule 2).
  The **watermark composes with it the same way it does for the FVG bot**: an overnight raid
  deepens the level's watermark, so the in-session raid that (re)arms has to go **deeper than the
  overnight one** — the mirror image of "a premarket push sets the level an in-session tap must
  beat". A sweep rejected for being out of session is reported as **`no-sweep`** in the
  diagnostics; there is no separate reason code for it.
- **No timer of any kind.** The per-TF candle deadline and the absolute minute cap of §6.2 do not
  apply — an armed sweep lives indefinitely. The **distance rule is the only death**: price
  trading farther than the invalidation distance from the level in either direction, beyond it
  (the raid became a breakout) or away from it (the move ran without a trigger). A death still
  stands only until the next qualifying raid *inside the resweep window*, and a breakout is still
  the one permanent exit. The BOT panel therefore shows no deadline inputs for this bot — only
  the distance and the resweep window.
- **Trigger scan = the full enabled trigger-TF list (15s–5m)**, as in §3 rule 3 — *not* the
  5m–1m narrowing the Mech Model applies. The per-TF toggles are the whole story.
- **Candidate ordering** is the FVG bot's: confirmation time ascending, with no trigger-TF
  tiebreak. (The filled-gap veto already decides which timeframe owns the move.)

### 7.3 Target, and what is deferred

- **The unfilled 5m/15m target of §6.3 applies in full** — same polarity rule, same closest-edge
  choice across 5m and 15m, same `targetGapMaxAgeMinutes` window, same "no target, no trade".
- Deferred, same as §6.3b: no runner management, and the same **rewind caveat** — cleared-blocker
  state is not reconstructed on rewind, so after a rewind the bot vetoes rather than over-fires.
