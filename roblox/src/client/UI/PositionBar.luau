--!strict
-- Minimal HUD strip: position, realized P&L, trade count, plus the two actions
-- that belong next to them (flatten, trade log). The readout is purely the
-- server's derived TradeState; flatten only SENDS a command and waits for the
-- state that answers it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Send = ({ [string]: any }) -> ()

local PAD = 6
local BTN_H = 18

local PositionBar = {}
PositionBar.__index = PositionBar

export type Callbacks = {
	send: Send,
	toggleLog: () -> (),
}

type Fields = {
	posChip: TextLabel,
	realized: TextLabel,
	tradeCount: TextLabel,
	flattenBtn: TextButton,
}

export type PositionBar = typeof(setmetatable({} :: Fields, PositionBar))

local function newChip(parent: Instance, x: number, w: number, filled: boolean): TextLabel
	local l = Instance.new("TextLabel")
	l.BorderSizePixel = 0
	l.AnchorPoint = Vector2.new(0, 0.5)
	l.Position = UDim2.new(0, x, 0.5, 0)
	l.Size = UDim2.fromOffset(w, 18)
	l.BackgroundTransparency = if filled then 0 else 1
	l.BackgroundColor3 = Theme.border
	l.Font = Enum.Font.Code
	l.TextSize = 12
	l.TextColor3 = Theme.textDim
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = ""
	l.Parent = parent
	return l
end

local function newButton(parent: Instance, name: string, x: number, w: number): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.BorderSizePixel = 0
	b.AnchorPoint = Vector2.new(0, 0.5)
	b.Position = UDim2.new(0, x, 0.5, 0)
	b.Size = UDim2.fromOffset(w, BTN_H)
	b.BackgroundColor3 = Theme.panelHover
	b.TextColor3 = Theme.text
	b.Font = Enum.Font.Code
	b.TextSize = 12
	b.Text = name
	b.Parent = parent
	return b
end

local function setText(label: TextLabel, text: string, color: Color3)
	if label.Text ~= text then
		label.Text = text
	end
	if label.TextColor3 ~= color then
		label.TextColor3 = color
	end
end

function PositionBar.update(self: PositionBar, state: Protocol.TradeState)
	local qty = state.position.qty
	-- Flatten is meaningless flat, and an always-visible one invites a stray
	-- click that cancels every working order for nothing.
	self.flattenBtn.Visible = qty ~= 0
	if qty == 0 then
		setText(self.posChip, "  flat", Theme.textDim)
	else
		local sign = if qty > 0 then "+" else ""
		setText(
			self.posChip,
			string.format("  %s%.1f @ %.2f", sign, qty, state.position.avgPrice),
			if qty > 0 then Theme.up else Theme.down
		)
	end
	local usd = state.realizedUsd
	setText(
		self.realized,
		"realized " .. ContractMath.fmtUsd(usd),
		if usd > 0 then Theme.up elseif usd < 0 then Theme.down else Theme.textDim
	)
	setText(self.tradeCount, string.format("trades %d", #state.trades), Theme.textDim)
end

function PositionBar.new(gui: ScreenGui, cbs: Callbacks): PositionBar
	local bar = Instance.new("Frame")
	bar.Name = "PositionBar"
	bar.BorderSizePixel = 0
	bar.BackgroundColor3 = Theme.bg
	bar.AnchorPoint = Vector2.new(0, 1)
	bar.Position = UDim2.new(0, 0, 1, -Theme.controlBarHeight)
	bar.Size = UDim2.new(1, 0, 0, Theme.positionBarHeight)
	bar.ZIndex = 1
	bar.Parent = gui

	local x = PAD
	local posChip = newChip(bar, x, 190, true)
	x += 190 + PAD * 2
	local realized = newChip(bar, x, 190, false)
	x += 190 + PAD * 2
	local tradeCount = newChip(bar, x, 110, false)
	x += 110 + PAD

	local logBtn = newButton(bar, "trade log", x, 76)
	x += 76 + PAD
	local flattenBtn = newButton(bar, "flatten", x, 64)
	flattenBtn.BackgroundColor3 = Theme.down
	flattenBtn.TextColor3 = Theme.bg
	flattenBtn.Visible = false

	local self: PositionBar = setmetatable(
		{
			posChip = posChip,
			realized = realized,
			tradeCount = tradeCount,
			flattenBtn = flattenBtn,
		} :: Fields,
		PositionBar
	)

	setText(posChip, "  flat", Theme.textDim)
	setText(realized, "realized " .. ContractMath.fmtUsd(0), Theme.textDim)
	setText(tradeCount, "trades 0", Theme.textDim)

	logBtn.Activated:Connect(function()
		cbs.toggleLog()
	end)
	flattenBtn.Activated:Connect(function()
		cbs.send({ cmd = "flatten" })
	end)
	return self
end

return PositionBar
