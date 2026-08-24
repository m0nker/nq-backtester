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

-- The HUD (position strip + control bar) owns this many pixels at the bottom
-- of the screen; the chart ScreenGui shortens itself by the same amount so the
-- two never overlap. They are separate ScreenGuis on purpose: LayerCollector
-- invalidation is per-ScreenGui and the chart repaints every frame.
M.positionBarHeight = 24
M.controlBarHeight = 36
M.hudHeight = M.positionBarHeight + M.controlBarHeight

return M
