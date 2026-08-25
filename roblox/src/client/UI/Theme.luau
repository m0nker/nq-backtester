--!strict
-- Dark palette and the few pixel constants the chart and the HUD must agree
-- on. Up/down are the web app's candle accents (ReplayChart.tsx SL/TP lines);
-- the surface colors are the TradingView dark ground the port targets.

local M = {}

M.bg = Color3.fromHex("131722")
M.grid = Color3.fromHex("1e222d")
M.panel = Color3.fromHex("1b1f2b")
M.panelHover = Color3.fromHex("262b39")
M.border = Color3.fromHex("2a2e39")
M.text = Color3.fromHex("d1d4dc")
M.textDim = Color3.fromHex("787b86")
M.accent = Color3.fromHex("f5b942")
M.up = Color3.fromHex("26a69a")
M.down = Color3.fromHex("ef5350")
M.crosshair = Color3.fromHex("585c6b")

-- Type. Every TextLabel/TextButton/TextBox in the client reads its Font and
-- TextSize from here — a module that names an Enum.Font itself is a bug,
-- because the two families below are not interchangeable:
--   fontUi   proportional, for anything a human reads as words.
--   fontMono fixed advance, for numbers that are REWRITTEN while the eye is
--            on them (the clock, the crosshair readouts, the price/time axes,
--            the order chips a drag re-prices every frame). A proportional
--            digit changes width as the value changes, so those readouts
--            would jitter horizontally on every update.
M.fontUi = Enum.Font.BuilderSans
M.fontUiMedium = Enum.Font.BuilderSansMedium
M.fontMono = Enum.Font.RobotoMono

-- One ladder, so nothing invents a size: sm = dense readouts and table cells,
-- md = controls and chips, lg = panel titles.
M.textSm = 12
M.textMd = 13
M.textLg = 15

-- The HUD (position strip + control bar) owns this many pixels at the bottom
-- of the screen; the chart ScreenGui shortens itself by the same amount so the
-- two never overlap. They are separate ScreenGuis on purpose: LayerCollector
-- invalidation is per-ScreenGui and the chart repaints every frame.
M.positionBarHeight = 24
M.controlBarHeight = 36
M.hudHeight = M.positionBarHeight + M.controlBarHeight

return M
