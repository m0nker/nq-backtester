--!strict
-- Minimal HUD strip: position, realized P&L, trade count. Purely a readout of
-- the server's derived TradeState — order placement is a later phase, so
-- nothing here is interactive.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))

local Client = script.Parent.Parent
local Messages = require(Client:WaitForChild("Net"):WaitForChild("Messages"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local PAD = 6

local PositionBar = {}
PositionBar.__index = PositionBar

type Fields = {
	posChip: TextLabel,
	realized: TextLabel,
	tradeCount: TextLabel,
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

local function setText(label: TextLabel, text: string, color: Color3)
	if label.Text ~= text then
		label.Text = text
	end
	if label.TextColor3 ~= color then
		label.TextColor3 = color
	end
end

function PositionBar.update(self: PositionBar, state: Messages.TradeState)
	local qty = state.position.qty
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

function PositionBar.new(gui: ScreenGui): PositionBar
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

	local self: PositionBar = setmetatable(
		{
			posChip = posChip,
			realized = realized,
			tradeCount = tradeCount,
		} :: Fields,
		PositionBar
	)

	setText(posChip, "  flat", Theme.textDim)
	setText(realized, "realized " .. ContractMath.fmtUsd(0), Theme.textDim)
	setText(tradeCount, "trades 0", Theme.textDim)
	return self
end

return PositionBar
