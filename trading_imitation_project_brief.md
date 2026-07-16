# Project Brief: Human-in-the-Loop Trading Imitation System

**Purpose of this document:** Full context for a fresh conversation. Everything below was worked out across a long design discussion. Read this and you understand what I want built, why, and in what order.

---

## 1. Who I am and what I'm trying to do

I'm a discretionary futures trader (NQ, prop firm funded accounts) with a profitable strategy backed by data. My strategy follows ICT (Inner Circle Trader / Smart Money Concepts). I also want this project to double as a data science resume portfolio (targeting DS-adjacent roles/co-ops).

**Core goal:** Build a system that learns *my personal trading discretion* — eventually a bot that can trade with my guidance or independently, but built in stages where every stage is independently valuable even if I stop there.

**Original idea (rejected):** Train AI on screen recordings of me analyzing TradingView charts with voice narration. Rejected because vision models read charts unreliably, and the video is a lossy encoding of data that already exists numerically (OHLCV). Voice narration was kept; video was dropped.

---

## 2. My strategy (ICT-based)

Two phases, each with its own discretion:

**Phase A — Bias determination (premarket, before 9:30 ET):**
Analyzing FVGs, draws on liquidity (session highs/lows, PDH/PDL/PWH/PWL, unfilled gaps, other highs/lows, low resistance liquidity) to form a directional bias.

**Phase B — Execution (9:30–11:00 ET):**
- Condition: 5/15/30/1h gap
- Highest timeframe IFVG (30s, 1m, 2, 3, 4, 5m)
- Clear targets
- Unfilled 5/15 (mechanical model logic)
- When to go breakeven
- When to align with bias vs. when it's OK to go against bias

**Machine-recognizable elements (all deterministic, computable from price data — no ML needed):**
- FVG recognition across timeframes (5m, 15, 30, 1h, 4h, 1d+)
- IFVG recognition on lower timeframes (30s, 1m, 2, 3, 4, 5m)
- Session highs and lows
- Filled vs. unfilled FVGs

**The structure of my discretion:** My entry criteria are mechanical. Discretion comes in two places: (1) **bias** — directional conviction, and (2) **selection** — which mechanical setups to take or skip. I can see conflicting bullish and bearish confluences, consciously list them, and use discretion to weight them. Bias is the harder part to model.

**My bias format is naturally structured:** "Bullish until NQ hits 25500" / "Bearish until NQ hits X." E.g., price at 25000, bias "bullish until 25500" → bot only looks for longs until price hits 25500.

---

## 3. The architecture (final design)

### Two layers
- **Layer 1 — Deterministic perception engine (pure code, no ML):** Ingests price data, emits complete confluence state per bar: every active FVG/IFVG across all timeframes (direction, boundaries, age, fill %), session/prior levels and sweep status, gap conditions, distances to each. Base it on the open-source `joshyattridge/smart-money-concepts` Python library (has FVG, OB, liquidity, swing detection, BOS/CHoCH) — but verify its definitions match mine, and add: session high/low logic, PDH/PDL/PWH/PWL, IFVG state tracking, multi-timeframe orchestration. **First deliverable before any code: a definitions doc** (exact FVG rules, fill thresholds — touch vs. CE/50% vs. full, IFVG invalidation, session boundaries/timezones). Validate by reproducing my manual TradingView markup of a real session exactly.
- **Layer 2 — Learned decision layer (ML):** Learns my discretion from labeled data. Human stays in the loop for bias; ML learns selection first.

### The human bias + mechanical bot design (the key pivot)
Instead of learning everything, keep **bias as human input** via a tiny structured DSL, and mechanize everything downstream:

**Bias DSL (~4 fields):** `{direction: long/short/neutral, invalidation_level: price, on_invalidation: flip/neutral/stop-for-day}`, optionally a two-sided bracket ("bullish above X, bearish below Y, no-trade between"). Open questions I need to answer from my own behavior: do I revise bias intraday for non-level reasons (needs a timestamped revise action)? Do I use brackets?

**Mechanical bot:** Takes every mechanical entry that aligns with the current bias. E.g., bias "bullish until 25500" → take every rule-based long signal until price hits 25500.

### The decomposition experiment (first big payoff)
Backtest the bot taking EVERY bias-aligned mechanical entry (no selection filter) and compare against my actual live record. Outcomes:
1. Bot ≈ me → selection discretion adds little; edge is bias + entries; huge automatable surface.
2. Bot profitable but worse → the gap is the quantified dollar value of my selection discretion (tells me what building the imitation layer is worth).
3. Bot loses while I win → my selection IS the edge; critical to know before anything trades unsupervised.

### Historical bias labels (lookahead problem)
Can't trust hindsight-recalled bias. Sources: (a) reconstruct from my actual trade log (coarse), (b) replay-annotate: chart frozen at 9:25 with future hidden, state bias — ~3 min/day, (c) **log bias live every premarket starting immediately** (10 sec/day, perfectly clean). Plan: (c) now + (b) for backlog.

---

## 4. The staged pipeline

**Stage 1 — Candidate generator.** Backtester runs over history; every bias-aligned signal becomes a candidate: `{timestamp, direction, entry, stop, target, bias_at_time, full confluence state}`. Hundreds of candidates from months of data.

**Stage 2 — Replay-review labeling UI.** Chart frozen at 9:25 → I enter bias → bot fast-forwards, pausing at each candidate (chart cut at signal bar, no future visible) → I label it. **5–10 min per historical day.** ~50 sessions ≈ few hundred labeled decisions.

**Labeling format (important refinement):** Instead of voice-only narration, each candidate prompt shows a **structured attribute form**: sliders/checkboxes for discretionary attributes I recognize but the bot can't compute (e.g., condition quality, target clarity, draw strength, counter-bias comfort). Rules: 5–8 attributes max (fatigue kills labeling), same form for takes AND skips (positive examples matter, not just disagreement data), **graded decision label** (take / marginal / hard skip — captures the gradient, tunable via threshold later), anchored sliders (write what 1/3/5 mean), versioned schema, voice demoted to an optional "notes" escape hatch mined later for missing attributes.

**What the un-computable attributes are for (four uses):**
1. **Concept-bottleneck model:** train `computed features → predicted attributes` then `attributes → decision`. Reveals which of my perceptions are mechanizable, attribute by attribute; interpretable ("skipping because I predict you'd rate condition quality 2/5").
2. **Feature-engineering roadmap:** attributes that predict my decisions AND outcomes → build computed proxies (e.g., displacement → body/range ratios). Attributes that predict my decisions but NOT outcomes → discovered superstition in my own discretion.
3. **Gap measurement:** model with ratings vs. model without = quantified value of my tacit perception = the honest autonomy ceiling.
4. **Live operation:** I rate the sliders in ~5 sec live; model scores with my ratings included. Human supplies perception, model supplies consistency.

**Stage 3 — Filter model.** Gradient boosting (LightGBM/XGBoost) on `(candidate features, bias context, [attributes]) → take/skip`. Tabular, small-data-friendly, SHAP-interpretable. Evaluate: agreement rate on held-out sessions (**walk-forward splits only, never random** — temporal leakage) + three-way P&L: bot-takes-all vs. bot-filtered-by-model vs. filtered-by-actual-me. Audit via SHAP whether it skips for MY stated reasons.

**Stage 4 — Live human-in-the-loop.** I type bias at 9:25; bot surfaces live candidates; model scores each ("take 0.87" / "skip 0.31 — high gap fill"); I make the final call. Every decision — especially disagreements — auto-becomes training data (DAgger pattern). Weekly retrain.

**Stage 5 — Bias model (last, maybe never).** Every session passively produces `(9:25 confluence snapshot → my bias statement)`. After 100–200 sessions, train it, run in shadow. If it converges, the last human input can automate; if not (bias may depend on news/narrative/feel), end state = 10 seconds of human judgment each morning steering an autonomous system. That's acceptable.

**LLM's role throughout:** not the decision engine — it's the interface: extract structured labels from voice notes, explain GBM decisions in ICT vocabulary via SHAP, translate my plain-English corrections into training data, flag when my stated reason references a feature missing from the schema.

---

## 5. Tech stack

- **Data:** NQ futures, tick/second-level (needed for 30s IFVGs — 1m insufficient), Databento (~$100–400 historical), stored Parquet, pandas/polars
- **Charting:** TradingView `lightweight-charts` (free, open source) in a Next.js app
- **Replay engine:** client-side cursor over bar array; reveal completed bars only (no lookahead; consider sub-bar 5s slices if intrabar behavior matters)
- **Audio:** browser MediaRecorder → Whisper (faster-whisper local or API)
- **Storage:** SQLite or Supabase — sessions table + decision events with state snapshot as JSON
- **ML:** LightGBM/XGBoost + SHAP; LLM API for extraction/interface
- **Total cost:** <$500/year. The real cost is time: build ≈ 2–4 weekends per major component; labeling ≈ 5–10 min/historical day.

---

## 6. Risks and constraints (known and accepted)

1. **Abandonment via scope** — most likely failure; mitigated by every stage being independently valuable.
2. **Layer 1 definition drift** — if detection differs from my eyes, everything downstream silently corrupts; mitigated by markup-reproduction validation.
3. **Tacit knowledge ceiling** — some edge may be un-articulable; measured (not solved) by the ratings-gap experiment.
4. **Thin data for rare decisions** — bias = 1 label/day; A+ setups rare.
5. **Regime change** — trained snapshot of my discretion doesn't adapt like I do; walk-forward monitoring detects decay.
6. **Prop firm automation policies** — Apex/Topstep restrict automation; realistic end state on funded accounts is "bot signals, I click." Check current policies before any execution stage.
7. **Overtrusting early results** — months of boring shadow mode before real money, regardless of how good six weeks looks.

---

## 7. Resume angle (secondary goal)

Stages map to DS material: labeling-pipeline/HITL design (Stage 2), feature engineering with validation (Layer 1), GBM + walk-forward + SHAP (Stage 3 — **the minimum viable endpoint**; even 150 labels → defensible model + honest evaluation; a mediocre model rigorously evaluated beats no model), deployment/online-vs-offline eval (Stage 4). Genericize jargon on the resume ("multi-timeframe market-structure features," not "FVGs"). README per stage, written as I go. Prior art searched: nothing does this exact pipeline (narrated/structured replay labels → personal imitation model); components exist (smart-money-concepts lib, FX Replay, TrendSpider, academic imitation-learning-for-trading papers like HA3C) — the annotation-driven personal-discretion bridge is the novel piece.

---

## 8. Immediate next steps (where the last conversation left off)

1. **Start logging bias live every premarket, in DSL form, starting now** (zero code, dataset accrues at 1/day).
2. **Write the definitions doc** (exact FVG/IFVG/level/session rules — 1 hour, everything depends on it).
3. **Draft the bias DSL** (an evening).
4. **Draft the attribute form** (go through the strategy's discretionary elements; for each: slider, checkbox, computed-by-Layer-1, or out of scope for v1).
5. **Spec the review UI** (one chart panel, take/marginal/skip buttons, attribute sliders, optional mic, candidate queue).
6. Then: build backtester → run the decomposition experiment.
