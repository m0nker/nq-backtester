--!strict
-- Tool strip for Chart/DrawingLayer: ray, line, rect, delete. A small vertical
-- panel on the left edge, below the order panel.
--
-- Arming is exclusive and idempotent (re-arming the live tool disarms), and
-- Escape disarms — the same contract OrderPanel's four arm buttons have, for
-- the same reason: the armed tool spends the NEXT chart click, so there must
-- always be a way to take it back without spending one.
--
-- NO button is the layer's select/edit mode: that mode is what the layer does
-- when nothing here is armed, so disarming is how you reach it. The panel
-- therefore has nothing to show for it.
--
-- KNOWN CAVEAT — double consumption. ChartView broadcasts a plot click to every
-- subscriber, and this toolbar cannot see whether OrderPanel is also armed. A
-- click made with both armed places an order AND a drawing. Accepted for this
-- round; the fix is an arbiter that owns the arm state for all consumers, not a
-- peek across panels. The same blind spot applies to the chart's armed-cursor
-- affordance: disarming here clears it even if OrderPanel is still armed.

local UserInputService = game:GetService("UserInputService")

local Client = script.Parent.Parent
local DrawingLayerModule = require(Client:WaitForChild("Chart"):WaitForChild("DrawingLayer"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type DrawingLayer = DrawingLayerModule.DrawingLayer

-- Clear of the order panel, which starts at (8, 8) and is ~230px tall at its
-- fullest (every row visible).
local PANEL_X = 8
local PANEL_Y = 340
local PANEL_W = 64
local PAD = 6
local BTN_H = 22
local BTN_GAP = 4

local Z_PANEL = 5
local Z_BTN = 6

-- Button order is the panel's layout order; the `tool` is what DrawingLayer is
-- armed with.
local TOOLS: { { tool: string, text: string } } = {
	{ tool = "ray", text = "ray" },
	{ tool = "line", text = "line" },
	{ tool = "rect", text = "rect" },
	{ tool = "del", text = "del" },
}

local DrawToolbar = {}
DrawToolbar.__index = DrawToolbar

type Fields = {
	layer: DrawingLayer,
	panel: Frame,
	buttons: { TextButton },
}

export type DrawToolbar = typeof(setmetatable({} :: Fields, DrawToolbar))

local function styleToggle(b: TextButton, active: boolean, activeColor: Color3)
	b.BackgroundColor3 = if active then activeColor else Theme.panelHover
	b.TextColor3 = if active then Theme.bg else Theme.textDim
end

function DrawToolbar.setTool(self: DrawToolbar, tool: string)
	self.layer:setTool(tool)
	local live = self.layer:getTool()
	for i, btn in ipairs(self.buttons) do
		-- delete is destructive, so it arms in the down color rather than the
		-- accent the placement tools share with every other armed control
		styleToggle(btn, TOOLS[i].tool == live, if TOOLS[i].tool == "del" then Theme.down else Theme.accent)
	end
end

function DrawToolbar.new(gui: ScreenGui, layer: DrawingLayer): DrawToolbar
	local panel = Instance.new("Frame")
	panel.Name = "DrawToolbar"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	panel.Position = UDim2.fromOffset(PANEL_X, PANEL_Y)
	panel.Size = UDim2.fromOffset(PANEL_W, PAD * 2 + #TOOLS * BTN_H + (#TOOLS - 1) * BTN_GAP)
	panel.ZIndex = Z_PANEL
	panel.Parent = gui

	local buttons: { TextButton } = {}
	for i, entry in ipairs(TOOLS) do
		local b = Instance.new("TextButton")
		b.Name = entry.tool
		b.BorderSizePixel = 0
		b.Position = UDim2.fromOffset(PAD, PAD + (i - 1) * (BTN_H + BTN_GAP))
		b.Size = UDim2.fromOffset(PANEL_W - PAD * 2, BTN_H)
		b.BackgroundColor3 = Theme.panelHover
		b.TextColor3 = Theme.textDim
		b.Font = Theme.fontUiMedium
		b.TextSize = Theme.textSm
		b.Text = entry.text
		b.AutoButtonColor = true
		b.ZIndex = Z_BTN
		b.Parent = panel
		buttons[i] = b
	end

	local self: DrawToolbar = setmetatable(
		{
			layer = layer,
			panel = panel,
			buttons = buttons,
		} :: Fields,
		DrawToolbar
	)

	for i, btn in ipairs(buttons) do
		btn.Activated:Connect(function()
			local entry = TOOLS[i]
			self:setTool(if layer:getTool() == entry.tool then "none" else entry.tool)
		end)
	end
	-- Escape is not routed through ContextActionService: it must not be sunk away
	-- from the rest of the client (OrderPanel listens for it too), and disarming
	-- an unarmed toolbar is free.
	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if not processed and input.KeyCode == Enum.KeyCode.Escape then
			self:setTool("none")
		end
	end)

	self:setTool("none")
	return self
end

return DrawToolbar
