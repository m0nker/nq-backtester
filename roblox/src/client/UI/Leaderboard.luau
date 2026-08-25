--!strict
-- Leaderboard panel: a readout of whatever the server's last Meta { kind =
-- "board" } said. The client ranks nothing and caches nothing across boards —
-- `rows` arrives already ordered (rank 1 first) and the server owns the TTL, so
-- this panel's only job is to ask and to draw.
--
-- Rows are pooled and rewritten only when a reply arrives or the panel toggles;
-- there is no polling and no per-frame work.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local PANEL_W = 380
local PANEL_H = 420
local PAD = 8
local TITLE_H = 24
local TAB_H = 22
local TAB_GAP = 4
local HEAD_H = 18
local ROW_H = 20
local REFRESH_W = 62
-- The server pages the board at 20 and never sends more; the pool is built once
-- at that size so a reply allocates nothing.
local MAX_ROWS = 20
-- Air between the last ranked row and the "you are outside it" block, so the
-- block does not read as rank 21.
local YOU_GAP = 10

local TAB_Y = TITLE_H
local HEAD_Y = TAB_Y + TAB_H + 4
local SEP_Y = HEAD_Y + HEAD_H
local LIST_Y = SEP_Y + 1

local LEFT = Enum.TextXAlignment.Left
local RIGHT = Enum.TextXAlignment.Right

type Col = { x: number, w: number, align: Enum.TextXAlignment, head: string }

local COL_RANK: Col = { x = 0, w = 26, align = RIGHT, head = "#" }
local COL_NAME: Col = { x = 32, w = 190, align = LEFT, head = "player" }
-- The value column's header is set per board (VALUE_HEADS) because the three
-- boards do not share a unit.
local COL_VALUE: Col = { x = 226, w = 126, align = RIGHT, head = "" }

-- `winRate` ranks PER-TRADE win rate over eligible trades, not winning
-- sessions; the tab says "trade" so the number is never read as the latter.
local TAB_LABELS: { [string]: string } = {
	pnlAll = "all-time pnl",
	pnlWeek = "this week",
	winRate = "trade win %",
}

local VALUE_HEADS: { [string]: string } = {
	pnlAll = "pnl",
	pnlWeek = "pnl",
	winRate = "win %",
}

-- Every board is gated on a minimum of scored sessions, so an empty board is
-- the NORMAL early state, not a failure — it gets a sentence rather than a
-- shrug. The gate thresholds live server-side (Board.eligible) and are
-- deliberately not restated here, where they would drift.
local EMPTY_TEXT = "no entries yet\nthis board fills as players finish scored sessions"

local Leaderboard = {}
Leaderboard.__index = Leaderboard

type Row = {
	frame: Frame,
	rank: TextLabel,
	name: TextLabel,
	value: TextLabel,
}

type Fields = {
	panel: Frame,
	valueHead: TextLabel,
	list: ScrollingFrame,
	status: TextLabel,
	divider: TextLabel,
	youRow: Row,
	tabs: { [string]: TextButton },
	rows: { Row },
	shown: number,
	board: string,
	-- The player's own id, used when a reply carries rows but no `you` (an
	-- ineligible player still sees the board).
	userId: number,
	send: ({ [string]: any }) -> (),
}

export type Leaderboard = typeof(setmetatable({} :: Fields, Leaderboard))

local function newCell(parent: Instance, col: Col): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.Position = UDim2.fromOffset(col.x, 0)
	l.Size = UDim2.fromOffset(col.w, ROW_H)
	l.Font = Theme.fontMono
	l.TextSize = Theme.textSm
	l.TextColor3 = Theme.text
	l.TextXAlignment = col.align
	l.Text = ""
	l.ZIndex = 9
	l.Parent = parent
	return l
end

local function makeRow(list: ScrollingFrame): Row
	local frame = Instance.new("Frame")
	frame.BorderSizePixel = 0
	frame.BackgroundTransparency = 1
	frame.Size = UDim2.new(1, 0, 0, ROW_H)
	frame.ZIndex = 9
	frame.Visible = false
	frame.Parent = list

	local rank = newCell(frame, COL_RANK)
	-- A name is words; the rank and the value are numbers rewritten under the
	-- eye on every refresh, so only those two take the fixed advance (Theme).
	local name = newCell(frame, COL_NAME)
	name.Font = Theme.fontUi
	local value = newCell(frame, COL_VALUE)

	return { frame = frame, rank = rank, name = name, value = value }
end

local function setCell(label: TextLabel, text: string, color: Color3)
	if label.Text ~= text then
		label.Text = text
	end
	if label.TextColor3 ~= color then
		label.TextColor3 = color
	end
end

-- `value` is dollars on the pnl boards and basis points on winRate — the wire
-- carries an integer there because OrderedDataStore values are integers.
local function fmtValue(board: string, value: number): string
	if board == "winRate" then
		return string.format("%.1f%%", value / 100)
	end
	return ContractMath.fmtUsd(value)
end

local function setStatus(self: Leaderboard, text: string?)
	self.status.Visible = text ~= nil
	if text ~= nil and self.status.Text ~= text then
		self.status.Text = text
	end
end

local function hideRows(self: Leaderboard)
	for k = 1, self.shown do
		self.rows[k].frame.Visible = false
	end
	self.shown = 0
	self.divider.Visible = false
	self.youRow.frame.Visible = false
	self.list.CanvasSize = UDim2.fromOffset(0, 0)
end

local function request(self: Leaderboard)
	-- The rows on screen belong to whichever board answered last; drop them
	-- before asking, or a slow reply leaves the previous board under the new tab.
	hideRows(self)
	setStatus(self, "loading...")
	self.send({ cmd = "board", board = self.board })
end

local function render(self: Leaderboard, msg: Protocol.MetaBoard)
	local rows = msg.rows
	local count = math.min(#rows, MAX_ROWS)
	local you = msg.you
	-- `you` is the server's own answer to "which row is mine"; LocalPlayer only
	-- covers the case where it was omitted.
	local meId = if you ~= nil then you.userId else self.userId

	for i = 1, count do
		local r = rows[i]
		local row = self.rows[i]
		local mine = r.userId == meId
		row.frame.Position = UDim2.fromOffset(0, (i - 1) * ROW_H)
		setCell(row.rank, tostring(r.rank), if mine then Theme.accent else Theme.textDim)
		setCell(row.name, r.name, if mine then Theme.accent else Theme.text)
		setCell(row.value, fmtValue(msg.board, r.value), if mine then Theme.accent else Theme.text)
	end
	for k = count + 1, self.shown do
		self.rows[k].frame.Visible = false
	end
	for k = self.shown + 1, count do
		self.rows[k].frame.Visible = true
	end
	self.shown = count

	-- rank 0 means "outside the page"; the server does not page the whole board
	-- to find a true global rank (META_PLAN §1.6), so neither does this row.
	-- An empty board cannot put anyone outside it, hence the count guard.
	local outside = if count > 0 and you ~= nil and you.rank == 0 then you else nil
	local height = count * ROW_H
	if outside ~= nil then
		local y = count * ROW_H + YOU_GAP
		local text = string.format("your rank: outside top %d", count)
		self.divider.Position = UDim2.fromOffset(0, y)
		if self.divider.Text ~= text then
			self.divider.Text = text
		end
		self.youRow.frame.Position = UDim2.fromOffset(0, y + ROW_H)
		setCell(self.youRow.rank, "-", Theme.accent)
		setCell(self.youRow.name, outside.name, Theme.accent)
		setCell(self.youRow.value, fmtValue(msg.board, outside.value), Theme.accent)
		height = y + ROW_H * 2
	end
	self.divider.Visible = outside ~= nil
	self.youRow.frame.Visible = outside ~= nil

	setStatus(self, if count == 0 then EMPTY_TEXT else nil)
	self.list.CanvasSize = UDim2.fromOffset(0, height)
end

local function styleTabs(self: Leaderboard)
	-- Iterated in BOARD_IDS order rather than over the dict: pairs() order is
	-- unspecified and the strip is observable output.
	for _, id in ipairs(Protocol.BOARD_IDS) do
		local b = self.tabs[id]
		local active = id == self.board
		-- Inactive tabs take panelHover, not panel: panel IS the ground behind
		-- them and they would vanish into it.
		b.BackgroundColor3 = if active then Theme.accent else Theme.panelHover
		b.TextColor3 = if active then Theme.bg else Theme.text
	end
end

local function selectBoard(self: Leaderboard, id: string)
	if id == self.board then
		return
	end
	self.board = id
	styleTabs(self)
	local head = VALUE_HEADS[id] or ""
	if self.valueHead.Text ~= head then
		self.valueHead.Text = head
	end
	request(self)
end

-- Main routes Meta { kind = "board" } here; every other kind is somebody else's.
function Leaderboard.onMeta(self: Leaderboard, msg: Protocol.MetaBoard)
	-- A tab switch fires a new request without cancelling the outstanding one,
	-- so a reply for a board the player has already left must be dropped rather
	-- than drawn under the new tab's header.
	if msg.board ~= self.board then
		return
	end
	render(self, msg)
end

function Leaderboard.isOpen(self: Leaderboard): boolean
	return self.panel.Visible
end

function Leaderboard.toggle(self: Leaderboard)
	local open = not self.panel.Visible
	self.panel.Visible = open
	if open then
		-- Boards go stale while the panel is shut and there is no polling, so an
		-- open is always a fetch. The server answers from its TTL cache.
		request(self)
	end
end

function Leaderboard.new(gui: ScreenGui, send: ({ [string]: any }) -> ()): Leaderboard
	local panel = Instance.new("Frame")
	panel.Name = "Leaderboard"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	-- Top-right, below the Roblox topbar (58px; this ScreenGui ignores the
	-- inset) and the "new session"/"boards" button row at y 66..90.
	panel.AnchorPoint = Vector2.new(1, 0)
	panel.Position = UDim2.new(1, -PAD, 0, 98)
	panel.Size = UDim2.fromOffset(PANEL_W, PANEL_H)
	panel.ZIndex = 8
	panel.Visible = false
	panel.Active = true -- swallow clicks aimed at the chart underneath
	panel.Parent = gui

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.BorderSizePixel = 0
	title.Position = UDim2.fromOffset(PAD, 0)
	title.Size = UDim2.new(1, -(PAD * 2 + REFRESH_W + 4), 0, TITLE_H)
	title.Font = Theme.fontUiMedium
	title.TextSize = Theme.textLg
	title.TextColor3 = Theme.text
	title.TextXAlignment = LEFT
	title.Text = "leaderboard"
	title.ZIndex = 9
	title.Parent = panel

	local refresh = Instance.new("TextButton")
	refresh.Name = "Refresh"
	refresh.BorderSizePixel = 0
	refresh.AnchorPoint = Vector2.new(1, 0)
	refresh.Position = UDim2.new(1, -PAD, 0, 3)
	refresh.Size = UDim2.fromOffset(REFRESH_W, 18)
	refresh.BackgroundColor3 = Theme.panelHover
	refresh.TextColor3 = Theme.text
	refresh.Font = Theme.fontUiMedium
	refresh.TextSize = Theme.textSm
	refresh.Text = "refresh"
	refresh.AutoButtonColor = true
	refresh.ZIndex = 9
	refresh.Parent = panel

	local tabW = math.floor((PANEL_W - PAD * 2 - TAB_GAP * 2) / 3)
	local tabs: { [string]: TextButton } = {}
	for i, id in ipairs(Protocol.BOARD_IDS) do
		local b = Instance.new("TextButton")
		b.Name = id
		b.BorderSizePixel = 0
		b.Position = UDim2.fromOffset(PAD + (i - 1) * (tabW + TAB_GAP), TAB_Y)
		b.Size = UDim2.fromOffset(tabW, TAB_H)
		b.BackgroundColor3 = Theme.panelHover
		b.TextColor3 = Theme.text
		b.Font = Theme.fontUiMedium
		b.TextSize = Theme.textSm
		b.Text = TAB_LABELS[id] or id
		b.AutoButtonColor = true
		b.ZIndex = 9
		b.Parent = panel
		tabs[id] = b
	end

	-- The header sits OUTSIDE the ScrollingFrame so the columns stay named while
	-- the rows scroll under them.
	local head = Instance.new("Frame")
	head.Name = "Header"
	head.BorderSizePixel = 0
	head.BackgroundTransparency = 1
	head.Position = UDim2.fromOffset(PAD, HEAD_Y)
	head.Size = UDim2.new(1, -(PAD * 2), 0, HEAD_H)
	head.ZIndex = 9
	head.Parent = panel

	local rankHead = newCell(head, COL_RANK)
	rankHead.Font = Theme.fontUi
	rankHead.TextColor3 = Theme.textDim
	rankHead.Text = COL_RANK.head
	local nameHead = newCell(head, COL_NAME)
	nameHead.Font = Theme.fontUi
	nameHead.TextColor3 = Theme.textDim
	nameHead.Text = COL_NAME.head
	local valueHead = newCell(head, COL_VALUE)
	valueHead.Font = Theme.fontUi
	valueHead.TextColor3 = Theme.textDim

	local sep = Instance.new("Frame")
	sep.Name = "Sep"
	sep.BorderSizePixel = 0
	sep.BackgroundColor3 = Theme.border
	sep.Position = UDim2.fromOffset(PAD, SEP_Y)
	sep.Size = UDim2.new(1, -(PAD * 2), 0, 1)
	sep.ZIndex = 9
	sep.Parent = panel

	local list = Instance.new("ScrollingFrame")
	list.Name = "Rows"
	list.BorderSizePixel = 0
	list.BackgroundTransparency = 1
	list.Position = UDim2.fromOffset(PAD, LIST_Y + 2)
	list.Size = UDim2.new(1, -(PAD * 2), 1, -(LIST_Y + 2 + PAD))
	list.CanvasSize = UDim2.fromOffset(0, 0)
	list.ScrollBarThickness = 6
	list.ZIndex = 8
	list.Parent = panel

	local status = Instance.new("TextLabel")
	status.Name = "Status"
	status.BackgroundTransparency = 1
	status.BorderSizePixel = 0
	-- Centered and wrapped: the empty board is a state the panel is expected to
	-- sit in for a while, and a dim line jammed into the top-left corner reads
	-- as a failed load instead.
	status.Position = UDim2.fromOffset(0, 24)
	status.Size = UDim2.new(1, 0, 0, ROW_H * 3)
	status.Font = Theme.fontUi
	status.TextSize = Theme.textSm
	status.TextColor3 = Theme.textDim
	status.TextXAlignment = Enum.TextXAlignment.Center
	status.TextWrapped = true
	status.Text = ""
	status.Visible = false
	status.ZIndex = 9
	status.Parent = list

	local divider = Instance.new("TextLabel")
	divider.Name = "YouDivider"
	divider.BackgroundTransparency = 1
	divider.BorderSizePixel = 0
	divider.Size = UDim2.new(1, 0, 0, ROW_H)
	divider.Font = Theme.fontUi
	divider.TextSize = Theme.textSm
	divider.TextColor3 = Theme.textDim
	divider.TextXAlignment = LEFT
	divider.Text = ""
	divider.Visible = false
	divider.ZIndex = 9
	divider.Parent = list

	local rows: { Row } = {}
	for _ = 1, MAX_ROWS do
		table.insert(rows, makeRow(list))
	end
	local youRow = makeRow(list)

	local self: Leaderboard = setmetatable(
		{
			panel = panel,
			valueHead = valueHead,
			list = list,
			status = status,
			divider = divider,
			youRow = youRow,
			tabs = tabs,
			rows = rows,
			shown = 0,
			board = Protocol.BOARD_IDS[1],
			userId = (Players.LocalPlayer :: Player).UserId,
			send = send,
		} :: Fields,
		Leaderboard
	)

	valueHead.Text = VALUE_HEADS[self.board] or ""
	styleTabs(self)

	for _, id in ipairs(Protocol.BOARD_IDS) do
		tabs[id].Activated:Connect(function()
			selectBoard(self, id)
		end)
	end
	refresh.Activated:Connect(function()
		request(self)
	end)

	return self
end

return Leaderboard
