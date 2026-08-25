--!strict
-- Session date picker: a drill-down over the dates SessionInfo offered — years,
-- then the months of one year, then the days of one month. Picking a day sends
-- startSession and closes; the "new session" button reopens it.
--
-- It is always dismissible — close button, scrim, or Escape — including before
-- any session exists. The chart behind it is then simply empty, which is a
-- better place to be stuck than inside a modal with no way out.
--
-- A row per date does not survive the catalog (2010-2026 is 4000+ trading
-- days), so nothing here ever draws one. The grid is a POOL of buttons
-- re-labelled as the player descends — at most max(31 days, 12 months, one
-- button per year) exist at any time — and the index below is rebuilt only when
-- the date set changes (a SessionInfo arrival), never per frame.
--
-- Dates are "YYYY-MM-DD" strings end to end. ISO strings sort and compare in
-- calendar order, so this file needs no date arithmetic and must never grow
-- any: Et.luau owns every calendar question in this port.

local UserInputService = game:GetService("UserInputService")

local SessionPicker = {}
SessionPicker.__index = SessionPicker

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local PAD = 10
local GRID_GAP = 4
-- Chosen so every level's cell width divides exactly: 4 cols -> 68, 3 -> 92,
-- 6 -> 44. A width that leaves a remainder puts a ragged edge on the grid.
local GRID_W = 284
local GRID_H = 200
local PANEL_W = GRID_W + PAD * 2
local PANEL_H = 304

local HEADER_Y = 10
local HEADER_H = 22
local BACK_W = 34
local BACK_GAP = 6
local CLOSE_W = HEADER_H -- square, so it reads as a dismiss and not as a word
local ENTRY_Y = 40
local ENTRY_H = 24
local GRID_Y = 72
local STATUS_Y = GRID_Y + GRID_H + 6
local STATUS_H = 16

local DATE_BOX_W = 100
local RANDOM_X = 106
local RANDOM_W = 84
local LATEST_X = 196
local LATEST_W = 88

local FLASH_SEC = 0.6

type GridSpec = { cols: number, cellH: number }

local YEAR_GRID: GridSpec = { cols = 4, cellH = 30 }
local MONTH_GRID: GridSpec = { cols = 3, cellH = 30 }
local DAY_GRID: GridSpec = { cols = 6, cellH = 26 }

local MONTH_KEYS = { "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12" }
local MONTH_NAMES = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }

-- The "random day" die. Seeded from os.clock and owned by the UI on purpose:
-- the replay is deterministic and nothing in this file may ever be asked to
-- reproduce a draw, so this must never be confused for a simulation RNG.
local rng = Random.new(math.floor(os.clock() * 1e6))

-- A pooled grid button plus what it currently stands for. The Activated
-- connection is made once, at creation, and reads these fields — a re-render
-- rewrites them rather than reconnecting.
type Slot = {
	btn: TextButton,
	kind: string, -- "year" | "month" | "day"
	value: string, -- year label | "YYYY-MM" | "YYYY-MM-DD"
	enabled: boolean,
}

type Fields = {
	modal: Frame,
	title: TextLabel,
	backBtn: TextButton,
	grid: ScrollingFrame,
	empty: TextLabel,
	dateBox: TextBox,
	randomBtn: TextButton,
	latestBtn: TextButton,
	status: TextLabel,
	slots: { Slot },
	shown: number,
	flashSeq: number,
	dirty: boolean,

	-- Index over the offered dates, rebuilt by setDates only.
	dates: { string }, -- exactly as received, so setDates can diff against it
	pickable: { string }, -- the well-formed subset; the uniform draw indexes THIS
	dateSet: { [string]: true }, -- membership for the typed date
	years: { string }, -- distinct years, ascending
	months: { [string]: { string } }, -- "YYYY-MM" -> its dates, ascending
	latest: string?, -- newest offered date, nil while none are offered

	-- Where the drill-down is standing. Survives a hide so that picking two days
	-- out of one month is two clicks, and is re-validated on every render.
	level: number,
	year: string?,
	monthKey: string?,

	onPick: (string) -> (),
}

export type SessionPicker = typeof(setmetatable({} :: Fields, SessionPicker))

-- The pooled buttons' one-time handlers re-render the grid they live in.
local render: (SessionPicker) -> ()

-- ---------------------------------------------------------------------------
-- index
-- ---------------------------------------------------------------------------

local function reindex(self: SessionPicker)
	local pickable: { string } = {}
	local years: { string } = {}
	local seenYear: { [string]: true } = {}
	local months: { [string]: { string } } = {}
	local dateSet: { [string]: true } = {}

	for _, date in ipairs(self.dates) do
		-- Anything that is not "YYYY-MM-DD" is not a date this picker can offer;
		-- dropping it here is what keeps every string slice below total, and what
		-- keeps the random draw from ever naming a day the grid cannot show.
		local y, m = string.match(date, "^(%d%d%d%d)-(%d%d)-%d%d$")
		if y == nil or m == nil then
			continue
		end
		table.insert(pickable, date)
		dateSet[date] = true
		if not seenYear[y] then
			seenYear[y] = true
			table.insert(years, y)
		end
		local key = y .. "-" .. m
		local bucket = months[key]
		if bucket == nil then
			bucket = {}
			months[key] = bucket
		end
		table.insert(bucket, date)
	end

	table.sort(years)
	-- The server already sorts availableDates, but grid order is observable
	-- output — sort each bucket rather than inherit that assumption. pairs order
	-- is unspecified and irrelevant here: every bucket is sorted in place.
	for _, bucket in pairs(months) do
		table.sort(bucket)
	end

	self.pickable = pickable
	self.years = years
	self.months = months
	self.dateSet = dateSet

	self.latest = nil
	local newest = years[#years]
	if newest ~= nil then
		for m = 12, 1, -1 do
			local bucket = months[newest .. "-" .. MONTH_KEYS[m]]
			if bucket ~= nil then
				self.latest = bucket[#bucket]
				break
			end
		end
	end
end

-- A setDates that drops the year the player is standing in must not leave the
-- grid pointing at a month that no longer exists.
local function resolve(self: SessionPicker)
	local year = self.year
	if year == nil or table.find(self.years, year) == nil then
		self.year = nil
		self.monthKey = nil
		self.level = 1
		return
	end
	local key = self.monthKey
	if self.level >= 3 and (key == nil or self.months[key] == nil) then
		self.monthKey = nil
		self.level = 2
	end
end

-- ---------------------------------------------------------------------------
-- feedback
-- ---------------------------------------------------------------------------

local function setStatus(self: SessionPicker, text: string, color: Color3)
	if self.status.Text ~= text then
		self.status.Text = text
	end
	if self.status.TextColor3 ~= color then
		self.status.TextColor3 = color
	end
end

-- Overlapping flashes would each schedule their own restore; the newest wins by
-- bumping the sequence number.
local function flashBox(self: SessionPicker)
	self.flashSeq += 1
	local seq = self.flashSeq
	self.dateBox.BackgroundColor3 = Theme.down
	task.delay(FLASH_SEC, function()
		if self.flashSeq == seq then
			self.dateBox.BackgroundColor3 = Theme.border
		end
	end)
end

-- ---------------------------------------------------------------------------
-- picking
-- ---------------------------------------------------------------------------

-- Every pick parks the drill-down on the picked day's own month, so reopening
-- lands one click from its neighbours — the day after the one just replayed is
-- the usual next session.
local function pick(self: SessionPicker, date: string)
	self.year = string.sub(date, 1, 4)
	self.monthKey = string.sub(date, 1, 7)
	self.level = 3
	self.dirty = true
	self:hide()
	self.onPick(date)
end

local function tryTyped(self: SessionPicker)
	local y, m, d = string.match(self.dateBox.Text, "^%s*(%d%d%d%d)-(%d%d)-(%d%d)%s*$")
	local date = if y ~= nil and m ~= nil and d ~= nil then y .. "-" .. m .. "-" .. d else nil
	-- Set membership is the whole validation: a well-formed date that is not
	-- offered (weekend, holiday, outside the catalog) fails the same way a
	-- malformed one does.
	if date == nil or self.dateSet[date] == nil then
		flashBox(self)
		setStatus(self, "no data for that date", Theme.down)
		return
	end
	self.dateBox.Text = ""
	pick(self, date)
end

-- ---------------------------------------------------------------------------
-- instance construction (startup / pool growth only)
-- ---------------------------------------------------------------------------

local function newButton(parent: Instance, name: string, text: string): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.BorderSizePixel = 0
	b.BackgroundColor3 = Theme.panelHover
	b.TextColor3 = Theme.text
	b.Font = Theme.fontUiMedium
	b.TextSize = Theme.textSm
	b.Text = text
	b.AutoButtonColor = true
	b.ZIndex = 12
	b.Parent = parent
	return b
end

local function makeSlot(self: SessionPicker): Slot
	local slot: Slot = {
		btn = newButton(self.grid, "Cell", ""),
		kind = "",
		value = "",
		enabled = false,
	}
	slot.btn.Visible = false
	slot.btn.Activated:Connect(function()
		if not slot.enabled then
			return
		end
		if slot.kind == "year" then
			self.year = slot.value
			self.monthKey = nil
			self.level = 2
			render(self)
		elseif slot.kind == "month" then
			self.monthKey = slot.value
			self.level = 3
			render(self)
		elseif slot.kind == "day" then
			pick(self, slot.value)
		end
	end)
	return slot
end

local function slotAt(self: SessionPicker, i: number): Slot
	local slot = self.slots[i]
	if slot == nil then
		slot = makeSlot(self)
		self.slots[i] = slot
	end
	return slot
end

-- ---------------------------------------------------------------------------
-- state -> pixels
-- ---------------------------------------------------------------------------

local function styleAction(btn: TextButton, enabled: boolean)
	local bg = if enabled then Theme.panelHover else Theme.bg
	if btn.BackgroundColor3 ~= bg then
		btn.BackgroundColor3 = bg
	end
	local fg = if enabled then Theme.text else Theme.textDim
	if btn.TextColor3 ~= fg then
		btn.TextColor3 = fg
	end
	if btn.AutoButtonColor ~= enabled then
		btn.AutoButtonColor = enabled
	end
end

-- `numeric` is what the cell HOLDS, not how it looks: years and days are digits
-- laid out in a grid and only line up under a fixed advance, month names are
-- words.
local function paint(slot: Slot, index: number, spec: GridSpec, text: string, enabled: boolean, numeric: boolean)
	local cellW = (GRID_W - GRID_GAP * (spec.cols - 1)) // spec.cols
	local col = (index - 1) % spec.cols
	local row = (index - 1) // spec.cols
	local btn = slot.btn
	slot.enabled = enabled

	local pos = UDim2.fromOffset(col * (cellW + GRID_GAP), row * (spec.cellH + GRID_GAP))
	if btn.Position ~= pos then
		btn.Position = pos
	end
	local size = UDim2.fromOffset(cellW, spec.cellH)
	if btn.Size ~= size then
		btn.Size = size
	end
	if btn.Text ~= text then
		btn.Text = text
	end
	local font = if numeric then Theme.fontMono else Theme.fontUiMedium
	if btn.Font ~= font then
		btn.Font = font
	end
	styleAction(btn, enabled)
end

local function setHeader(self: SessionPicker, text: string, showBack: boolean)
	if self.title.Text ~= text then
		self.title.Text = text
	end
	local x = if showBack then PAD + BACK_W + BACK_GAP else PAD
	local pos = UDim2.fromOffset(x, HEADER_Y)
	if self.title.Position ~= pos then
		self.title.Position = pos
	end
	if self.backBtn.Visible ~= showBack then
		self.backBtn.Visible = showBack
	end
end

render = function(self: SessionPicker)
	self.dirty = false
	resolve(self)

	-- Each branch re-derives its own level from the index rather than trusting
	-- self.level, so a stale level can only ever draw a SHALLOWER grid.
	local year = self.year
	local key = self.monthKey
	local days = if key ~= nil then self.months[key] else nil

	local spec = YEAR_GRID
	local used = 0

	if #self.years == 0 then
		setHeader(self, "pick a session", false)
	elseif self.level >= 3 and key ~= nil and days ~= nil then
		spec = DAY_GRID
		for i, date in ipairs(days) do
			local slot = slotAt(self, i)
			slot.kind = "day"
			slot.value = date
			-- day-of-month, two digits: the grid only reads as a calendar if the
			-- numbers sit on a fixed advance
			paint(slot, i, spec, string.sub(date, 9, 10), true, true)
			used = i
		end
		setHeader(self, key, true)
	elseif self.level >= 2 and year ~= nil then
		spec = MONTH_GRID
		for m = 1, 12 do
			local monthKey = year .. "-" .. MONTH_KEYS[m]
			local slot = slotAt(self, m)
			slot.kind = "month"
			slot.value = monthKey
			paint(slot, m, spec, MONTH_NAMES[m], self.months[monthKey] ~= nil, false)
		end
		used = 12
		setHeader(self, year, true)
	else
		spec = YEAR_GRID
		for i, label in ipairs(self.years) do
			local slot = slotAt(self, i)
			slot.kind = "year"
			slot.value = label
			paint(slot, i, spec, label, true, true)
			used = i
		end
		setHeader(self, "pick a session", false)
	end

	for i = used + 1, self.shown do
		local slot = self.slots[i]
		slot.enabled = false
		slot.btn.Visible = false
	end
	for i = self.shown + 1, used do
		self.slots[i].btn.Visible = true
	end
	self.shown = used

	self.empty.Visible = used == 0
	local rows = math.max(1, math.ceil(used / spec.cols))
	self.grid.CanvasSize = UDim2.fromOffset(0, rows * (spec.cellH + GRID_GAP) - GRID_GAP)
	-- a level change re-uses the same canvas; leaving it scrolled would open the
	-- new grid part-way down
	self.grid.CanvasPosition = Vector2.new(0, 0)

	styleAction(self.randomBtn, #self.pickable > 0)
	styleAction(self.latestBtn, self.latest ~= nil)
	setStatus(self, "", Theme.textDim)
end

-- ---------------------------------------------------------------------------
-- public surface
-- ---------------------------------------------------------------------------

function SessionPicker.show(self: SessionPicker)
	if self.dirty then
		render(self)
	end
	self.modal.Visible = true
end

function SessionPicker.hide(self: SessionPicker)
	self.modal.Visible = false
end

function SessionPicker.isOpen(self: SessionPicker): boolean
	return self.modal.Visible
end

function SessionPicker.setDates(self: SessionPicker, dates: { string })
	if #dates == #self.dates then
		local same = true
		for i, d in ipairs(dates) do
			if self.dates[i] ~= d then
				same = false
				break
			end
		end
		if same then
			return
		end
	end
	self.dates = table.clone(dates)
	reindex(self)
	self.dirty = true
	-- A re-setDates while the modal is open has to land immediately; while it is
	-- closed the rebuild waits for the next show.
	if self.modal.Visible then
		render(self)
	end
end

function SessionPicker.new(gui: ScreenGui, onPick: (string) -> ()): SessionPicker
	local modal = Instance.new("Frame")
	modal.Name = "SessionPicker"
	modal.BorderSizePixel = 0
	modal.BackgroundColor3 = Theme.bg
	modal.BackgroundTransparency = 0.35
	modal.Size = UDim2.fromScale(1, 1)
	modal.ZIndex = 10
	modal.Visible = false
	modal.Active = true -- swallow clicks aimed at the chart underneath
	modal.Parent = gui

	local panel = Instance.new("Frame")
	panel.Name = "Panel"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.Size = UDim2.fromOffset(PANEL_W, PANEL_H)
	panel.ZIndex = 11
	-- Sinks the clicks the scrim below must not see: a click that misses a grid
	-- button but lands on the panel is not a dismissal.
	panel.Active = true
	panel.Parent = modal

	-- Clicking anywhere outside the panel closes without choosing. A button
	-- rather than an input handler, and BELOW the panel, so the panel occludes
	-- it — the same shape as Controls' step-menu scrim.
	local scrim = Instance.new("TextButton")
	scrim.Name = "Scrim"
	scrim.BorderSizePixel = 0
	scrim.BackgroundTransparency = 1
	scrim.Size = UDim2.fromScale(1, 1)
	scrim.Text = ""
	scrim.AutoButtonColor = false
	scrim.ZIndex = 10
	scrim.Parent = modal

	local closeBtn = newButton(panel, "Close", "\u{00D7}")
	closeBtn.AnchorPoint = Vector2.new(1, 0)
	closeBtn.Position = UDim2.new(1, -PAD, 0, HEADER_Y)
	closeBtn.Size = UDim2.fromOffset(CLOSE_W, HEADER_H)
	closeBtn.TextSize = Theme.textLg

	local backBtn = newButton(panel, "Back", "<")
	backBtn.Position = UDim2.fromOffset(PAD, HEADER_Y)
	backBtn.Size = UDim2.fromOffset(BACK_W, HEADER_H)
	backBtn.Visible = false

	local title = Instance.new("TextLabel")
	title.Name = "Title"
	title.BackgroundTransparency = 1
	title.BorderSizePixel = 0
	title.Position = UDim2.fromOffset(PAD, HEADER_Y)
	-- narrow enough that the longest header ("pick a session") cannot reach the
	-- close button from the indented, back-button position
	title.Size = UDim2.fromOffset(GRID_W - BACK_W - BACK_GAP - CLOSE_W - BACK_GAP, HEADER_H)
	title.Font = Theme.fontUiMedium
	title.TextSize = Theme.textLg
	title.TextColor3 = Theme.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = "pick a session"
	title.ZIndex = 12
	title.Parent = panel

	local dateBox = Instance.new("TextBox")
	dateBox.Name = "DateBox"
	dateBox.BorderSizePixel = 0
	dateBox.Position = UDim2.fromOffset(PAD, ENTRY_Y)
	dateBox.Size = UDim2.fromOffset(DATE_BOX_W, ENTRY_H)
	dateBox.BackgroundColor3 = Theme.border
	dateBox.TextColor3 = Theme.text
	-- a date typed digit by digit, rewritten in place
	dateBox.Font = Theme.fontMono
	dateBox.TextSize = Theme.textSm
	dateBox.PlaceholderText = "YYYY-MM-DD"
	dateBox.PlaceholderColor3 = Theme.textDim
	dateBox.Text = ""
	dateBox.ClearTextOnFocus = false
	dateBox.ZIndex = 12
	dateBox.Parent = panel

	local randomBtn = newButton(panel, "Random", "random day")
	randomBtn.Position = UDim2.fromOffset(PAD + RANDOM_X, ENTRY_Y)
	randomBtn.Size = UDim2.fromOffset(RANDOM_W, ENTRY_H)

	local latestBtn = newButton(panel, "Latest", "latest")
	latestBtn.Position = UDim2.fromOffset(PAD + LATEST_X, ENTRY_Y)
	latestBtn.Size = UDim2.fromOffset(LATEST_W, ENTRY_H)

	-- A ScrollingFrame, not a Frame: the year level grows with the catalog and a
	-- clipped row would be a year nobody could reach. Every level's canvas fits
	-- its own frame today, so no scrollbar is drawn.
	local grid = Instance.new("ScrollingFrame")
	grid.Name = "Grid"
	grid.BorderSizePixel = 0
	grid.BackgroundTransparency = 1
	grid.Position = UDim2.fromOffset(PAD, GRID_Y)
	grid.Size = UDim2.fromOffset(GRID_W, GRID_H)
	grid.CanvasSize = UDim2.fromOffset(0, 0)
	grid.ScrollBarThickness = 6
	grid.ZIndex = 11
	grid.Parent = panel

	local empty = Instance.new("TextLabel")
	empty.Name = "Empty"
	empty.BackgroundTransparency = 1
	empty.BorderSizePixel = 0
	empty.Size = UDim2.fromOffset(GRID_W, 20)
	empty.Font = Theme.fontUi
	empty.TextSize = Theme.textSm
	empty.TextColor3 = Theme.textDim
	empty.TextXAlignment = Enum.TextXAlignment.Left
	empty.Text = "waiting for server..."
	empty.ZIndex = 12
	empty.Parent = grid

	local status = Instance.new("TextLabel")
	status.Name = "Status"
	status.BackgroundTransparency = 1
	status.BorderSizePixel = 0
	status.Position = UDim2.fromOffset(PAD, STATUS_Y)
	status.Size = UDim2.fromOffset(GRID_W, STATUS_H)
	status.Font = Theme.fontUi
	status.TextSize = Theme.textSm
	status.TextColor3 = Theme.textDim
	status.TextXAlignment = Enum.TextXAlignment.Left
	status.Text = ""
	status.ZIndex = 12
	status.Parent = panel

	local openBtn = Instance.new("TextButton")
	openBtn.Name = "NewSession"
	openBtn.BorderSizePixel = 0
	openBtn.AnchorPoint = Vector2.new(1, 0)
	-- y=66: below the Roblox topbar (58px) — the HUD ScreenGui ignores the
	-- inset, so a small y renders inside the topbar strip.
	openBtn.Position = UDim2.new(1, -8, 0, 66)
	openBtn.Size = UDim2.fromOffset(110, 24)
	openBtn.BackgroundColor3 = Theme.panel
	openBtn.TextColor3 = Theme.text
	openBtn.Font = Theme.fontUiMedium
	openBtn.TextSize = Theme.textSm
	openBtn.Text = "new session"
	openBtn.ZIndex = 5
	openBtn.Parent = gui

	local self: SessionPicker = setmetatable(
		{
			modal = modal,
			title = title,
			backBtn = backBtn,
			grid = grid,
			empty = empty,
			dateBox = dateBox,
			randomBtn = randomBtn,
			latestBtn = latestBtn,
			status = status,
			slots = {},
			shown = 0,
			flashSeq = 0,
			dirty = true,

			dates = {},
			pickable = {},
			dateSet = {},
			years = {},
			months = {},
			latest = nil,

			level = 1,
			year = nil,
			monthKey = nil,

			onPick = onPick,
		} :: Fields,
		SessionPicker
	)

	openBtn.Activated:Connect(function()
		self:show()
	end)

	backBtn.Activated:Connect(function()
		if self.level >= 3 then
			self.monthKey = nil
			self.level = 2
		else
			self.year = nil
			self.level = 1
		end
		render(self)
	end)

	randomBtn.Activated:Connect(function()
		-- uniform over the WHOLE catalog, not over the level currently open
		local n = #self.pickable
		if n == 0 then
			return
		end
		pick(self, self.pickable[rng:NextInteger(1, n)])
	end)

	latestBtn.Activated:Connect(function()
		local date = self.latest
		if date == nil then
			return
		end
		pick(self, date)
	end)

	-- Only Enter commits: a click on any grid button blurs the box too, and
	-- starting the typed session instead of the clicked one would be a session
	-- nobody asked for.
	dateBox.FocusLost:Connect(function(enterPressed: boolean)
		if enterPressed then
			tryTyped(self)
		end
	end)
	dateBox.Focused:Connect(function()
		setStatus(self, "", Theme.textDim)
	end)

	closeBtn.Activated:Connect(function()
		self:hide()
	end)
	scrim.Activated:Connect(function()
		self:hide()
	end)
	-- Escape is not routed through ContextActionService: it must not be sunk away
	-- from the rest of the client (OrderPanel and DrawToolbar disarm on it too),
	-- and closing a closed picker is free. Gated on the focused box because the
	-- date field shares this keyboard.
	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if processed or UserInputService:GetFocusedTextBox() ~= nil then
			return
		end
		if input.KeyCode == Enum.KeyCode.Escape then
			self:hide()
		end
	end)

	render(self)
	return self
end

return SessionPicker
