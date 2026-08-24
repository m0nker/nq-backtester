--!strict
-- Order entry. Every field here is a REQUEST: the server re-validates side,
-- type, quantity, prices and bracket distances, quantizes the qty and rounds
-- the prices to the tick. The checks below exist only so a typo is answered by
-- a red flash instead of by silence from a command the server dropped.
--
-- Market orders fill at the NEXT bar's open (Shared.Trading.Fills), so the
-- price row is hidden for them: there is no level to name.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Send = ({ [string]: any }) -> ()

local PANEL_W = 176
local PAD = 6
local ROW_H = 22
local ROW_GAP = 4
local SUBMIT_H = 28
local INNER = PANEL_W - PAD * 2

local QTY_STEP = ContractMath.QTY_STEP
local DEFAULT_QTY = 1
local DEFAULT_SL_PTS = 10
local DEFAULT_TP_PTS = 20
local FLASH_SEC = 0.6

local TYPE_LABELS: { { type: string, text: string } } = {
	{ type = "market", text = "MKT" },
	{ type = "limit", text = "LMT" },
	{ type = "stop", text = "STP" },
}

-- Overlapping flashes on one box would each schedule their own restore; the
-- newest flash wins by bumping the box's sequence number.
local flashSeq: { [TextBox]: number } = {}

local OrderPanel = {}
OrderPanel.__index = OrderPanel

type Row = { frame: Frame, h: number }

type Fields = {
	send: Send,
	getLastClose: () -> number?,
	panel: Frame,
	rows: { Row },

	buyBtn: TextButton,
	sellBtn: TextButton,
	typeBtns: { [string]: TextButton },
	qtyBox: TextBox,
	priceBox: TextBox,
	priceRow: Frame,
	bracketBtn: TextButton,
	ptsRow: Frame,
	slBox: TextBox,
	tpBox: TextBox,
	submitBtn: TextButton,

	side: string,
	otype: string,
	qty: number,
	bracketOn: boolean,
}

export type OrderPanel = typeof(setmetatable({} :: Fields, OrderPanel))

-- ---------------------------------------------------------------------------
-- parsing / feedback
-- ---------------------------------------------------------------------------

-- tonumber alone is not enough: "1e999" parses to inf, and an inf or NaN that
-- reaches string.format prints garbage into the UI before the server ever sees
-- it.
local function parseNum(text: string): number?
	local v = tonumber(text)
	if v == nil or v ~= v or v == math.huge or v == -math.huge then
		return nil
	end
	return v
end

local function flash(box: TextBox)
	local seq = (flashSeq[box] or 0) + 1
	flashSeq[box] = seq
	box.BackgroundColor3 = Theme.down
	task.delay(FLASH_SEC, function()
		if flashSeq[box] == seq then
			box.BackgroundColor3 = Theme.border
		end
	end)
end

local function setBoxText(box: TextBox, text: string)
	if box.Text ~= text then
		box.Text = text
	end
end

-- ---------------------------------------------------------------------------
-- instance construction (startup only)
-- ---------------------------------------------------------------------------

local function newRow(panel: Frame, name: string, h: number): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BorderSizePixel = 0
	f.BackgroundTransparency = 1
	f.Size = UDim2.new(1, 0, 0, h)
	f.ZIndex = 5
	f.Parent = panel
	return f
end

local function newButton(parent: Instance, name: string, x: number, w: number, h: number): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.BorderSizePixel = 0
	b.AnchorPoint = Vector2.new(0, 0.5)
	b.Position = UDim2.new(0, x, 0.5, 0)
	b.Size = UDim2.fromOffset(w, h)
	b.BackgroundColor3 = Theme.panelHover
	b.TextColor3 = Theme.text
	b.Font = Enum.Font.Code
	b.TextSize = 12
	b.Text = name
	b.AutoButtonColor = true
	b.ZIndex = 6
	b.Parent = parent
	return b
end

local function newLabel(parent: Instance, x: number, w: number, text: string): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.AnchorPoint = Vector2.new(0, 0.5)
	l.Position = UDim2.new(0, x, 0.5, 0)
	l.Size = UDim2.fromOffset(w, ROW_H)
	l.Font = Enum.Font.Code
	l.TextSize = 12
	l.TextColor3 = Theme.textDim
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = text
	l.ZIndex = 6
	l.Parent = parent
	return l
end

local function newBox(parent: Instance, name: string, x: number, w: number): TextBox
	local b = Instance.new("TextBox")
	b.Name = name
	b.BorderSizePixel = 0
	b.AnchorPoint = Vector2.new(0, 0.5)
	b.Position = UDim2.new(0, x, 0.5, 0)
	b.Size = UDim2.fromOffset(w, ROW_H - 4)
	b.BackgroundColor3 = Theme.border
	b.TextColor3 = Theme.text
	b.Font = Enum.Font.Code
	b.TextSize = 12
	b.Text = ""
	b.ClearTextOnFocus = false
	b.ZIndex = 6
	b.Parent = parent
	return b
end

-- ---------------------------------------------------------------------------
-- state -> pixels
-- ---------------------------------------------------------------------------

local function styleToggle(b: TextButton, active: boolean, activeColor: Color3)
	b.BackgroundColor3 = if active then activeColor else Theme.panelHover
	b.TextColor3 = if active then Theme.bg else Theme.textDim
end

local function sideColor(side: string): Color3
	return if side == "buy" then Theme.up else Theme.down
end

-- Rows stack in declaration order and a hidden row takes no space, so the panel
-- shrinks around the fields that are actually live.
local function relayout(self: OrderPanel)
	local y = PAD
	for _, row in ipairs(self.rows) do
		if row.frame.Visible then
			row.frame.Position = UDim2.fromOffset(0, y)
			y += row.h + ROW_GAP
		end
	end
	self.panel.Size = UDim2.fromOffset(PANEL_W, y - ROW_GAP + PAD)
end

local function typeAbbr(otype: string): string
	for _, entry in ipairs(TYPE_LABELS) do
		if entry.type == otype then
			return entry.text
		end
	end
	return "?"
end

local function syncSubmit(self: OrderPanel)
	local text = string.format("%s %s", if self.side == "buy" then "BUY" else "SELL", typeAbbr(self.otype))
	if self.submitBtn.Text ~= text then
		self.submitBtn.Text = text
	end
	self.submitBtn.BackgroundColor3 = sideColor(self.side)
end

function OrderPanel.setSide(self: OrderPanel, side: string)
	self.side = side
	styleToggle(self.buyBtn, side == "buy", Theme.up)
	styleToggle(self.sellBtn, side == "sell", Theme.down)
	syncSubmit(self)
end

function OrderPanel.setType(self: OrderPanel, otype: string)
	self.otype = otype
	for t, btn in pairs(self.typeBtns) do
		styleToggle(btn, t == otype, Theme.accent)
	end
	local wantPrice = otype ~= "market"
	if wantPrice and not self.priceRow.Visible then
		-- the last close is the only price the client is allowed to know, and it
		-- is the level the trader is looking at when they reach for this row
		local last = self.getLastClose()
		setBoxText(self.priceBox, if last ~= nil then string.format("%.2f", last) else "")
	end
	self.priceRow.Visible = wantPrice
	syncSubmit(self)
	relayout(self)
end

function OrderPanel.setBracket(self: OrderPanel, on: boolean)
	self.bracketOn = on
	styleToggle(self.bracketBtn, on, Theme.accent)
	self.bracketBtn.Text = if on then "bracket ON" else "bracket off"
	self.ptsRow.Visible = on
	relayout(self)
end

function OrderPanel.setQty(self: OrderPanel, qty: number)
	self.qty = math.max(QTY_STEP, ContractMath.quantizeQty(qty))
	setBoxText(self.qtyBox, string.format("%.1f", self.qty))
end

-- ---------------------------------------------------------------------------

function OrderPanel.submit(self: OrderPanel)
	local ok = true

	local qty = parseNum(self.qtyBox.Text)
	if qty == nil or qty <= 0 then
		flash(self.qtyBox)
		ok = false
	end

	local price: number? = nil
	if self.otype ~= "market" then
		price = parseNum(self.priceBox.Text)
		if price == nil then
			flash(self.priceBox)
			ok = false
		end
	end

	local slPts: number? = nil
	local tpPts: number? = nil
	if self.bracketOn then
		-- Bracket legs are DISTANCES from the fill; a non-positive one would put
		-- the leg on the wrong side of the entry.
		slPts = parseNum(self.slBox.Text)
		if slPts == nil or slPts <= 0 then
			flash(self.slBox)
			ok = false
		end
		tpPts = parseNum(self.tpBox.Text)
		if tpPts == nil or tpPts <= 0 then
			flash(self.tpBox)
			ok = false
		end
	end

	if not ok or qty == nil then
		return
	end
	self:setQty(qty)

	local payload: { [string]: any } = {
		cmd = "placeOrder",
		side = self.side,
		type = self.otype,
		qty = self.qty,
	}
	if self.otype == "limit" then
		payload.limitPrice = price
	elseif self.otype == "stop" then
		payload.stopPrice = price
	end
	if slPts ~= nil and tpPts ~= nil then
		payload.bracket = { stopLossPts = slPts, takeProfitPts = tpPts }
	end
	self.send(payload)
end

function OrderPanel.new(gui: ScreenGui, send: Send, getLastClose: () -> number?): OrderPanel
	local panel = Instance.new("Frame")
	panel.Name = "OrderPanel"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	panel.Position = UDim2.fromOffset(8, 8)
	panel.Size = UDim2.fromOffset(PANEL_W, 200)
	panel.ZIndex = 4
	panel.Active = true -- swallow clicks aimed at the chart underneath
	panel.Parent = gui

	local sideRow = newRow(panel, "Side", ROW_H)
	local buyBtn = newButton(sideRow, "BUY", PAD, 78, ROW_H)
	local sellBtn = newButton(sideRow, "SELL", PAD + 82, 78, ROW_H)

	local typeRow = newRow(panel, "Type", ROW_H)
	local typeBtns: { [string]: TextButton } = {}
	for i, entry in ipairs(TYPE_LABELS) do
		typeBtns[entry.type] = newButton(typeRow, entry.text, PAD + (i - 1) * 56, 52, ROW_H)
	end

	local qtyRow = newRow(panel, "Qty", ROW_H)
	newLabel(qtyRow, PAD, 26, "qty")
	local qtyDown = newButton(qtyRow, "-", PAD + 28, 24, ROW_H)
	local qtyBox = newBox(qtyRow, "QtyBox", PAD + 56, 76)
	local qtyUp = newButton(qtyRow, "+", PAD + 136, 24, ROW_H)

	local priceRow = newRow(panel, "Price", ROW_H)
	newLabel(priceRow, PAD, 26, "px")
	local priceBox = newBox(priceRow, "PriceBox", PAD + 28, INNER - 28)

	local bracketRow = newRow(panel, "Bracket", ROW_H)
	local bracketBtn = newButton(bracketRow, "bracket off", PAD, INNER, ROW_H)

	local ptsRow = newRow(panel, "Pts", ROW_H)
	newLabel(ptsRow, PAD, 20, "SL")
	local slBox = newBox(ptsRow, "SlBox", PAD + 22, 54)
	newLabel(ptsRow, PAD + 80, 20, "TP")
	local tpBox = newBox(ptsRow, "TpBox", PAD + 102, 54)

	local submitRow = newRow(panel, "Submit", SUBMIT_H)
	local submitBtn = newButton(submitRow, "BUY MKT", PAD, INNER, SUBMIT_H)

	local self: OrderPanel = setmetatable(
		{
			send = send,
			getLastClose = getLastClose,
			panel = panel,
			rows = {
				{ frame = sideRow, h = ROW_H },
				{ frame = typeRow, h = ROW_H },
				{ frame = qtyRow, h = ROW_H },
				{ frame = priceRow, h = ROW_H },
				{ frame = bracketRow, h = ROW_H },
				{ frame = ptsRow, h = ROW_H },
				{ frame = submitRow, h = SUBMIT_H },
			},
			buyBtn = buyBtn,
			sellBtn = sellBtn,
			typeBtns = typeBtns,
			qtyBox = qtyBox,
			priceBox = priceBox,
			priceRow = priceRow,
			bracketBtn = bracketBtn,
			ptsRow = ptsRow,
			slBox = slBox,
			tpBox = tpBox,
			submitBtn = submitBtn,
			side = "buy",
			otype = "market",
			qty = DEFAULT_QTY,
			bracketOn = false,
		} :: Fields,
		OrderPanel
	)

	setBoxText(slBox, string.format("%g", DEFAULT_SL_PTS))
	setBoxText(tpBox, string.format("%g", DEFAULT_TP_PTS))
	self:setQty(DEFAULT_QTY)
	self:setSide("buy")
	self:setType("market")
	self:setBracket(false)

	buyBtn.Activated:Connect(function()
		self:setSide("buy")
	end)
	sellBtn.Activated:Connect(function()
		self:setSide("sell")
	end)
	for otype, btn in pairs(typeBtns) do
		btn.Activated:Connect(function()
			self:setType(otype)
		end)
	end
	qtyDown.Activated:Connect(function()
		self:setQty(self.qty - QTY_STEP)
	end)
	qtyUp.Activated:Connect(function()
		self:setQty(self.qty + QTY_STEP)
	end)
	-- A rejected edit reverts to the last accepted value rather than clearing:
	-- the box is also the qty stepper's readout.
	qtyBox.FocusLost:Connect(function()
		local v = parseNum(qtyBox.Text)
		if v == nil or v <= 0 then
			flash(qtyBox)
			self:setQty(self.qty)
			return
		end
		self:setQty(v)
	end)
	bracketBtn.Activated:Connect(function()
		self:setBracket(not self.bracketOn)
	end)
	submitBtn.Activated:Connect(function()
		self:submit()
	end)

	return self
end

return OrderPanel
