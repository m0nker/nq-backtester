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
  4. the trading day ends (the session-tap rule above — armed never survives to the next day),
  5. **a trade is taken in its direction** (locked 2026-07-30): a long execution unarms **every**
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
