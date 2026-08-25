--!strict
-- Bottom control bar. Every button only SENDS a Cmd; the visible state of the
-- transport comes back from the Clock remote. The client never advances time
-- itself — that is the whole basis of the port's anti-lookahead guarantee.
--
-- Timeframe is the one exception: it is a pure display choice, re-aggregated
-- locally from bars the server already revealed.
--
-- The keyboard bindings are the same commands as the buttons. Every one of
-- them is gated on GetFocusedTextBox() being nil: the order panel's fields and
-- the jump box share this keyboard, and a space typed into a qty box must not
-- toggle play — nor may a "5" typed there reach the timeframe buffer.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Timeframe = Types.Timeframe
type Send = ({ [string]: any }) -> ()

local PAD = 4
local TF_BTN_W = 34
local BTN_H = 26

-- Jump-to-time group (right-hand end of the bar). The box takes an ET wall
-- time inside the session's own trading day; the preset is the RTH open.
local JUMP_BOX_W = 60
local JUMP_GO_W = 30
local JUMP_PRESET_W = 52
local JUMP_GAP = 4
local JUMP_PRESET = "09:30"
local FLASH_SEC = 0.6

-- Step size is either a concrete timeframe or this: "follow the chart". The
-- server has no such mode (Protocol), so "view" never travels — it only
-- decides which CONCRETE timeframe setStepSize carries.
local STEP_VIEW = "view"

-- Dropdown geometry. Both the step and the speed menu are the same widget with
-- different rows, so only the widths differ.
local MENU_ROW_H = 22
local MENU_PAD = 3
local STEP_MENU_W = 86
local SPEED_MENU_W = 78

-- Typed-timeframe buffer (TradingView). A digit no longer switches timeframe
-- on its own keypress: it STARTS or EXTENDS this buffer, and Enter is the only
-- thing that applies it — "1" and "15" cannot be told apart at the moment the
-- "1" arrives. Going idle CANCELS the buffer rather than applying it, so a
-- half-typed timeframe never lands on the chart by itself.
local BUFFER_IDLE_SEC = 2.5
local BUFFER_W = 168
local BUFFER_H = 48

local BUFFER_DIGITS: { [Enum.KeyCode]: string } = {
	[Enum.KeyCode.Zero] = "0",
	[Enum.KeyCode.One] = "1",
	[Enum.KeyCode.Two] = "2",
	[Enum.KeyCode.Three] = "3",
	[Enum.KeyCode.Four] = "4",
	[Enum.KeyCode.Five] = "5",
	[Enum.KeyCode.Six] = "6",
	[Enum.KeyCode.Seven] = "7",
	[Enum.KeyCode.Eight] = "8",
	[Enum.KeyCode.Nine] = "9",
}

-- Letters carry their case from Shift because InputBegan reports a KeyCode and
-- not a character, and case is load-bearing on exactly one of them: "M" is the
-- month, "m" is the minute suffix. "s" is accepted only so that a typed "30s"
-- reads as invalid — this port has no sub-minute data, and silently dropping
-- the "s" would switch to 30 MINUTES instead.
local BUFFER_LETTERS: { [Enum.KeyCode]: string } = {
	[Enum.KeyCode.D] = "d",
	[Enum.KeyCode.H] = "h",
	[Enum.KeyCode.M] = "m",
	[Enum.KeyCode.S] = "s",
	[Enum.KeyCode.W] = "w",
}

local Controls = {}
Controls.__index = Controls

export type Callbacks = {
	send: Send,
	setTimeframe: (Timeframe) -> (),
}

-- One dropdown: a full-screen dismiss scrim plus the row list itself, both
-- parented to the HUD ScreenGui because the menu opens UPWARD out of the bar.
type Flyout = {
	menu: Frame,
	scrim: TextButton,
	rows: { [string]: TextButton },
}

type FlyoutOption = { value: string, text: string }

type Fields = {
	cbs: Callbacks,
	clockLabel: TextLabel,
	playBtn: TextButton,
	fwdBtn: TextButton,
	jumpBox: TextBox,
	speedBtn: TextButton,
	speedFlyout: Flyout,
	stepBtn: TextButton,
	stepFlyout: Flyout,
	tfButtons: { [Timeframe]: TextButton },
	tfOverlay: Frame,
	tfText: TextLabel,
	tfHint: TextLabel,
	tf: Timeframe,
	playing: boolean,
	speed: number,
	-- every bar revealed: step/play are no-ops until a rewind
	atEnd: boolean,
	-- the trading date the jump box's HH:MM is resolved against, nil until a
	-- session is running
	sessionDate: string?,
	jumpSeq: number,
	-- A concrete Types.TIMEFRAMES value pins stepping to that timeframe;
	-- STEP_VIEW follows the chart's. Either way the CONCRETE timeframe is what
	-- travels in setStepSize.
	stepMode: string,
	-- what the SERVER last said it is stepping by; the button reports this
	-- rather than the last click, so a rejected setStepSize cannot lie
	serverStepSize: string,
	-- what has been typed toward a timeframe, "" when nothing is pending
	tfBuffer: string,
	-- newest pending buffer timer; an older one that fires is ignored
	tfSeq: number,
}

export type Controls = typeof(setmetatable({} :: Fields, Controls))

local function styleButton(b: TextButton, active: boolean)
	b.BackgroundColor3 = if active then Theme.accent else Theme.panel
	b.TextColor3 = if active then Theme.bg else Theme.text
end

local function newButton(parent: Instance, x: number, w: number, text: string): TextButton
	local b = Instance.new("TextButton")
	b.Name = text
	b.BorderSizePixel = 0
	b.AnchorPoint = Vector2.new(0, 0.5)
	b.Position = UDim2.new(0, x, 0.5, 0)
	b.Size = UDim2.fromOffset(w, BTN_H)
	b.Font = Theme.fontUiMedium
	b.TextSize = Theme.textMd
	b.Text = text
	b.AutoButtonColor = true
	b.Parent = parent
	styleButton(b, false)
	return b
end

local function newLabel(parent: Instance, x: number, w: number, color: Color3): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.AnchorPoint = Vector2.new(0, 0.5)
	l.Position = UDim2.new(0, x, 0.5, 0)
	l.Size = UDim2.fromOffset(w, BTN_H)
	-- the clock is rewritten on every reveal: fixed advance or it shuffles
	l.Font = Theme.fontMono
	l.TextSize = Theme.textMd
	l.TextColor3 = color
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = ""
	l.Parent = parent
	return l
end

-- Right-hand jump group: box + go + the RTH-open preset. Anchored to the right
-- edge so it never collides with the timeframe ladder growing from the left.
local function newJumpGroup(bar: Frame): (TextBox, TextButton, TextButton)
	local group = Instance.new("Frame")
	group.Name = "JumpGroup"
	group.BorderSizePixel = 0
	group.BackgroundTransparency = 1
	group.AnchorPoint = Vector2.new(1, 0.5)
	group.Position = UDim2.new(1, -PAD, 0.5, 0)
	group.Size = UDim2.fromOffset(JUMP_BOX_W + JUMP_GO_W + JUMP_PRESET_W + JUMP_GAP * 2, BTN_H)
	group.Parent = bar

	local box = Instance.new("TextBox")
	box.Name = "JumpBox"
	box.BorderSizePixel = 0
	box.Size = UDim2.fromOffset(JUMP_BOX_W, BTN_H)
	box.BackgroundColor3 = Theme.border
	box.TextColor3 = Theme.text
	-- a wall-clock time, rewritten in place
	box.Font = Theme.fontMono
	box.TextSize = Theme.textMd
	box.PlaceholderText = "HH:MM"
	box.PlaceholderColor3 = Theme.textDim
	box.Text = ""
	box.ClearTextOnFocus = false
	box.Parent = group

	local go = newButton(group, JUMP_BOX_W + JUMP_GAP, JUMP_GO_W, "go")
	local preset = newButton(group, JUMP_BOX_W + JUMP_GAP + JUMP_GO_W + JUMP_GAP, JUMP_PRESET_W, JUMP_PRESET)
	return box, go, preset
end

-- Overlapping flashes would each schedule their own restore; the newest wins by
-- bumping the sequence number.
local function flashJump(self: Controls)
	self.jumpSeq += 1
	local seq = self.jumpSeq
	self.jumpBox.BackgroundColor3 = Theme.down
	task.delay(FLASH_SEC, function()
		if self.jumpSeq == seq then
			self.jumpBox.BackgroundColor3 = Theme.border
		end
	end)
end

local function parseHhMm(text: string): (number?, number?)
	local hs, ms = string.match(text, "^%s*(%d%d?):(%d%d)%s*$")
	local h = tonumber(hs)
	local mi = tonumber(ms)
	if h == nil or mi == nil or h > 23 or mi > 59 then
		return nil, nil
	end
	return h, mi
end

-- The epoch second an ET wall time names inside the RUNNING session's day. A
-- trading day runs from 18:00 ET the evening before its trading date through
-- that afternoon, so an evening wall time belongs to the calendar day BEFORE
-- the date the session is named for. Et's civil-date arithmetic is linear in
-- the day number, so day 0 is exactly the last day of the previous month.
--
-- The server refuses anything outside [startTs, endTs] silently, so a time this
-- returns is still only a request.
local function jumpTarget(self: Controls, h: number, mi: number): number?
	local date = self.sessionDate
	if date == nil then
		return nil
	end
	local ys, mos, ds = string.match(date, "^(%d%d%d%d)-(%d%d)-(%d%d)$")
	local y = tonumber(ys)
	local mo = tonumber(mos)
	local d = tonumber(ds)
	if y == nil or mo == nil or d == nil then
		return nil
	end
	return Et.etWallToUtc(y, mo, if h >= 18 then d - 1 else d, h, mi)
end

local function doJump(self: Controls, text: string)
	local h, mi = parseHhMm(text)
	local t = if h ~= nil and mi ~= nil then jumpTarget(self, h, mi) else nil
	if t == nil then
		flashJump(self)
		return
	end
	self.cbs.send({ cmd = "jumpTo", t = t })
end

-- Dimmed, never disabled: the buttons still send and the server answers a step
-- past the last bar by doing nothing, so the dimming is a statement about the
-- data rather than a lock on the transport.
local function syncEnd(self: Controls)
	local fwd = if self.atEnd then Theme.textDim else Theme.text
	if self.fwdBtn.TextColor3 ~= fwd then
		self.fwdBtn.TextColor3 = fwd
	end
	local play = if self.atEnd then Theme.textDim elseif self.playing then Theme.bg else Theme.text
	if self.playBtn.TextColor3 ~= play then
		self.playBtn.TextColor3 = play
	end
end

-- The concrete timeframe the server should step by, given the local mode.
local function stepSizeFor(self: Controls): string
	return if self.stepMode == STEP_VIEW then self.tf else self.stepMode
end

local function setFlyoutOpen(f: Flyout, open: boolean)
	f.menu.Visible = open
	f.scrim.Visible = open
end

local function syncFlyoutRows(f: Flyout, selected: string)
	for value, row in pairs(f.rows) do
		styleButton(row, value == selected)
	end
end

-- The button names the MODE ("view" is a mode, not a size); every concrete
-- mode names the size the server confirmed.
local function syncStep(self: Controls)
	local text = "step " .. (if self.stepMode == STEP_VIEW then STEP_VIEW else self.serverStepSize)
	if self.stepBtn.Text ~= text then
		self.stepBtn.Text = text
	end
	syncFlyoutRows(self.stepFlyout, self.stepMode)
end

-- Speed is SERVER state: the button and the checked row both report the last
-- Clock, never the last click, so a rejected setSpeed cannot lie.
local function syncSpeed(self: Controls)
	local text = string.format("%d bar/s", self.speed)
	if self.speedBtn.Text ~= text then
		self.speedBtn.Text = text
	end
	syncFlyoutRows(self.speedFlyout, tostring(self.speed))
end

local function setStepMode(self: Controls, mode: string)
	self.stepMode = mode
	setFlyoutOpen(self.stepFlyout, false)
	syncStep(self)
	self.cbs.send({ cmd = "setStepSize", stepSize = stepSizeFor(self) })
end

local function pickSpeed(self: Controls, speed: number)
	setFlyoutOpen(self.speedFlyout, false)
	if speed ~= self.speed then
		self.cbs.send({ cmd = "setSpeed", speed = speed })
	end
end

-- The menu is parented to the HUD ScreenGui, not to the control bar: it opens
-- UPWARD out of the bar's bounds, and the scrim that dismisses it has to cover
-- the whole screen. Rows are built once — every option list here is static.
-- Both scrims are full-screen, so an open menu also swallows the click that
-- would open the other one: only ever one is up.
local function newFlyout(gui: ScreenGui, name: string, x: number, w: number, options: { FlyoutOption }): Flyout
	local scrim = Instance.new("TextButton")
	scrim.Name = name .. "Scrim"
	scrim.BorderSizePixel = 0
	scrim.BackgroundTransparency = 1
	scrim.AutoButtonColor = false
	scrim.Text = ""
	scrim.Size = UDim2.fromScale(1, 1)
	scrim.ZIndex = 19
	scrim.Visible = false
	scrim.Parent = gui

	local menu = Instance.new("Frame")
	menu.Name = name
	menu.BorderSizePixel = 0
	menu.BackgroundColor3 = Theme.border
	menu.AnchorPoint = Vector2.new(0, 1)
	menu.Position = UDim2.new(0, x, 1, -(Theme.controlBarHeight + 2))
	menu.Size = UDim2.fromOffset(w, #options * MENU_ROW_H + MENU_PAD * 2)
	menu.ZIndex = 20
	menu.Visible = false
	menu.Active = true
	menu.Parent = gui

	local rows: { [string]: TextButton } = {}
	for i, option in ipairs(options) do
		local row = Instance.new("TextButton")
		row.Name = option.value
		row.BorderSizePixel = 0
		row.Position = UDim2.fromOffset(MENU_PAD, MENU_PAD + (i - 1) * MENU_ROW_H)
		row.Size = UDim2.fromOffset(w - MENU_PAD * 2, MENU_ROW_H)
		row.Font = Theme.fontUi
		row.TextSize = Theme.textMd
		row.Text = option.text
		row.AutoButtonColor = true
		row.ZIndex = 21
		row.Parent = menu
		styleButton(row, false)
		rows[option.value] = row
	end
	return { menu = menu, scrim = scrim, rows = rows }
end

local function stepOptions(): { FlyoutOption }
	local options: { FlyoutOption } = { { value = STEP_VIEW, text = STEP_VIEW } }
	for _, tf in ipairs(Types.TIMEFRAMES) do
		table.insert(options, { value = tf, text = tf })
	end
	return options
end

-- Keyed by the DECIMAL SPELLING of the speed: the flyout is generic over
-- strings, and Clock's speed round-trips through tostring to find its row.
local function speedOptions(): { FlyoutOption }
	local options: { FlyoutOption } = {}
	for _, speed in ipairs(Protocol.SPEEDS) do
		table.insert(options, { value = tostring(speed), text = string.format("%d bar/s", speed) })
	end
	return options
end

-- Centred over the whole HUD and above both flyouts. A plain Frame with no
-- Active flag passes clicks through, so the buffer can sit over anything.
local function newTfOverlay(gui: ScreenGui): (Frame, TextLabel, TextLabel)
	local frame = Instance.new("Frame")
	frame.Name = "TfBuffer"
	frame.BorderSizePixel = 0
	frame.BackgroundColor3 = Theme.border
	frame.AnchorPoint = Vector2.new(0.5, 0.5)
	frame.Position = UDim2.fromScale(0.5, 0.5)
	frame.Size = UDim2.fromOffset(BUFFER_W, BUFFER_H)
	frame.ZIndex = 30
	frame.Visible = false
	frame.Parent = gui

	local text = Instance.new("TextLabel")
	text.Name = "Typed"
	text.BackgroundTransparency = 1
	text.BorderSizePixel = 0
	text.Position = UDim2.fromOffset(0, 6)
	text.Size = UDim2.new(1, 0, 0, 20)
	-- the caret sits at the end of a value rewritten on every keystroke, so
	-- fixed advance or the whole string walks sideways as it grows
	text.Font = Theme.fontMono
	text.TextSize = Theme.textLg
	text.TextColor3 = Theme.text
	text.Text = ""
	text.ZIndex = 31
	text.Parent = frame

	local hint = Instance.new("TextLabel")
	hint.Name = "Hint"
	hint.BackgroundTransparency = 1
	hint.BorderSizePixel = 0
	hint.Position = UDim2.fromOffset(0, 26)
	hint.Size = UDim2.new(1, 0, 0, 16)
	hint.Font = Theme.fontUi
	hint.TextSize = Theme.textSm
	hint.TextColor3 = Theme.textDim
	hint.Text = ""
	hint.ZIndex = 31
	hint.Parent = frame

	return frame, text, hint
end

-- TradingView-style typed switching, ported from the web's parseTypedTf
-- (ReplayControls.tsx): "1"->1m, "15"->15m, "60"/"1h"->1h, "240"/"4h"->4h,
-- "d"->1D, "w"->1W, "M"/"1M"->1M. Case decides one thing only: a trailing
-- capital M is the MONTH, so "15M" is not a timeframe while "15m" is.
-- Sub-minute spellings are rejected outright — the web accepts "30s" against
-- 1s data this port does not have.
local function parseTypedTf(raw: string): Timeframe?
	if raw == "m" or raw == "M" or raw == "1M" then
		return "1M"
	end
	if string.sub(raw, -1) == "M" then
		return nil
	end
	local s = string.lower(raw)
	if s == "d" or s == "1d" then
		return "1D"
	end
	if s == "w" or s == "1w" then
		return "1W"
	end
	if string.sub(s, -1) == "s" then
		return nil
	end
	if string.sub(s, -1) == "h" then
		local n = tonumber(string.sub(s, 1, -2))
		return if n == 1 then "1h" elseif n == 4 then "4h" else nil
	end
	local n = tonumber(if string.sub(s, -1) == "m" then string.sub(s, 1, -2) else s)
	if n == nil then
		return nil
	end
	if n == 60 then
		return "1h"
	end
	if n == 240 then
		return "4h"
	end
	local tf = string.format("%dm", n)
	return if table.find(Types.TIMEFRAMES, tf) ~= nil then tf else nil
end

local function syncBuffer(self: Controls, invalid: boolean)
	local shown = self.tfBuffer ~= ""
	if self.tfOverlay.Visible ~= shown then
		self.tfOverlay.Visible = shown
	end
	if not shown then
		return
	end
	local bg = if invalid then Theme.down else Theme.border
	if self.tfOverlay.BackgroundColor3 ~= bg then
		self.tfOverlay.BackgroundColor3 = bg
	end
	local text = self.tfBuffer .. "_"
	if self.tfText.Text ~= text then
		self.tfText.Text = text
	end
	local hint = if invalid then "not a timeframe" else "enter to switch"
	if self.tfHint.Text ~= hint then
		self.tfHint.Text = hint
	end
	local hintColor = if invalid then Theme.chipText else Theme.textDim
	if self.tfHint.TextColor3 ~= hintColor then
		self.tfHint.TextColor3 = hintColor
	end
end

-- One pending timer at a time (flashJump's idiom): the newest keystroke owns
-- the countdown, and a stale one that fires finds its sequence number gone.
local function armBuffer(self: Controls, sec: number)
	self.tfSeq += 1
	local seq = self.tfSeq
	task.delay(sec, function()
		if self.tfSeq == seq then
			self.tfBuffer = ""
			syncBuffer(self, false)
		end
	end)
end

local function clearBuffer(self: Controls)
	self.tfSeq += 1
	self.tfBuffer = ""
	syncBuffer(self, false)
end

local function pushBuffer(self: Controls, ch: string)
	self.tfBuffer ..= ch
	syncBuffer(self, false)
	armBuffer(self, BUFFER_IDLE_SEC)
end

local function backspaceBuffer(self: Controls)
	if self.tfBuffer == "" then
		return
	end
	self.tfBuffer = string.sub(self.tfBuffer, 1, -2)
	syncBuffer(self, false)
	armBuffer(self, BUFFER_IDLE_SEC)
end

local function highlightTf(self: Controls)
	for tf, btn in pairs(self.tfButtons) do
		styleButton(btn, tf == self.tf)
	end
end

-- Every speed change starts from the SERVER's current speed, so a dropped Cmd
-- cannot leave the ladder position walking away from the clock.
local function speedIndex(self: Controls): number
	return table.find(Protocol.SPEEDS, self.speed) or 1
end

-- The arrow keys walk the ladder and stop at its ends; the menu is how you
-- reach a rung directly.
local function nudgeSpeed(self: Controls, dir: number)
	local idx = math.clamp(speedIndex(self) + dir, 1, #Protocol.SPEEDS)
	local speed = Protocol.SPEEDS[idx]
	if speed ~= self.speed then
		self.cbs.send({ cmd = "setSpeed", speed = speed })
	end
end

-- Ctrl/Alt combinations are shortcuts, not typing: they must not feed the
-- timeframe buffer.
local function modifierHeld(): boolean
	return UserInputService:IsKeyDown(Enum.KeyCode.LeftControl)
		or UserInputService:IsKeyDown(Enum.KeyCode.RightControl)
		or UserInputService:IsKeyDown(Enum.KeyCode.LeftAlt)
		or UserInputService:IsKeyDown(Enum.KeyCode.RightAlt)
end

local function typedChar(key: Enum.KeyCode): string?
	local digit = BUFFER_DIGITS[key]
	if digit ~= nil then
		return digit
	end
	local letter = BUFFER_LETTERS[key]
	if letter == nil then
		return nil
	end
	local shift = UserInputService:IsKeyDown(Enum.KeyCode.LeftShift)
		or UserInputService:IsKeyDown(Enum.KeyCode.RightShift)
	return if shift then string.upper(letter) else letter
end

local function wireKeyboard(self: Controls)
	-- Space is play/pause, and the avatar's default jump must not fire with
	-- it. It is claimed through ContextActionService — handled AND sunk here —
	-- because a sunk input reaches UserInputService with processed=true, so the
	-- generic handler below could never see it.
	game:GetService("ContextActionService"):BindAction("BacktesterPlayPause", function(_, state: Enum.UserInputState)
		if UserInputService:GetFocusedTextBox() ~= nil then
			return Enum.ContextActionResult.Pass -- typing a space, not commanding
		end
		if state == Enum.UserInputState.Begin then
			-- Ctrl+Space steps exactly one bar and never touches play/pause (the
			-- web's binding). The action is bound to the Space KeyCode alone, so
			-- the modifier has to be read here rather than come in with it.
			if
				UserInputService:IsKeyDown(Enum.KeyCode.LeftControl)
				or UserInputService:IsKeyDown(Enum.KeyCode.RightControl)
			then
				self.cbs.send({ cmd = "stepForward" })
			else
				self.cbs.send({ cmd = if self.playing then "pause" else "play" })
			end
		end
		return Enum.ContextActionResult.Sink
	end, false, Enum.KeyCode.Space)

	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if processed or UserInputService:GetFocusedTextBox() ~= nil then
			return
		end
		local key = input.KeyCode
		local ch = if modifierHeld() then nil else typedChar(key)
		if ch ~= nil then
			pushBuffer(self, ch)
			return
		end
		if key == Enum.KeyCode.Return or key == Enum.KeyCode.KeypadEnter then
			local tf = if self.tfBuffer == "" then nil else parseTypedTf(self.tfBuffer)
			if tf ~= nil then
				self:setTimeframe(tf)
				clearBuffer(self)
			elseif self.tfBuffer ~= "" then
				-- red for one flash, then gone: a rejected entry must not sit
				-- there looking like it is still pending.
				syncBuffer(self, true)
				armBuffer(self, FLASH_SEC)
			end
			return
		end
		if key == Enum.KeyCode.Backspace then
			backspaceBuffer(self)
			return
		end
		if key == Enum.KeyCode.Escape then
			-- Escape is broadcast, never sunk (OrderPanel and DrawToolbar listen
			-- for it too); cancelling an empty buffer is free.
			clearBuffer(self)
			return
		end
		if key == Enum.KeyCode.Right then
			self.cbs.send({ cmd = "stepForward" })
		elseif key == Enum.KeyCode.Left then
			self.cbs.send({ cmd = "stepBack" })
		elseif key == Enum.KeyCode.Up then
			nudgeSpeed(self, 1)
		elseif key == Enum.KeyCode.Down then
			nudgeSpeed(self, -1)
		end
	end)
end

function Controls.setTimeframe(self: Controls, tf: Timeframe)
	if tf == self.tf then
		return
	end
	self.tf = tf
	highlightTf(self)
	self.cbs.setTimeframe(tf)
	if self.stepMode == "view" then
		self.cbs.send({ cmd = "setStepSize", stepSize = stepSizeFor(self) })
	end
end

-- The trading date the jump box resolves its HH:MM against. It arrives either
-- with a resumed SessionInfo or with the startSession the picker just sent —
-- the server does NOT re-send SessionInfo on start — and until one of the two
-- lands there is no day for a jump to fall in.
function Controls.setSessionDate(self: Controls, date: string?)
	self.sessionDate = date
end

-- Authoritative transport state: the bar renders what the server reports, not
-- what the last click asked for.
function Controls.onClock(self: Controls, msg: Protocol.Clock)
	local atEnd = msg.atEnd == true
	-- The suffix rides on the clock's own text so the two can never disagree
	-- about which timestamp is the last one.
	local t = Et.formatET(msg.t, true) .. (if atEnd then " - end" else "")
	if self.clockLabel.Text ~= t then
		self.clockLabel.Text = t
	end
	local restyle = false
	if self.atEnd ~= atEnd then
		self.atEnd = atEnd
		restyle = true
	end
	if self.playing ~= msg.playing then
		self.playing = msg.playing
		-- "auto" rather than "play": the label sits next to two step buttons and
		-- a play wedge alone reads as "step forward", which is what it is NOT.
		self.playBtn.Text = if msg.playing then "|| playing" else "> auto"
		-- styleButton owns the active/inactive pair; syncEnd overrides the text
		-- colour afterwards, so it has to run second.
		styleButton(self.playBtn, msg.playing)
		restyle = true
	end
	if restyle then
		syncEnd(self)
	end
	if self.speed ~= msg.speed then
		self.speed = msg.speed
		syncSpeed(self)
	end
	if self.serverStepSize ~= msg.stepSize then
		self.serverStepSize = msg.stepSize
		syncStep(self)
	end
end

function Controls.new(gui: ScreenGui, cbs: Callbacks): Controls
	local bar = Instance.new("Frame")
	bar.Name = "ControlBar"
	bar.BorderSizePixel = 0
	bar.BackgroundColor3 = Theme.panel
	bar.AnchorPoint = Vector2.new(0, 1)
	bar.Position = UDim2.fromScale(0, 1)
	bar.Size = UDim2.new(1, 0, 0, Theme.controlBarHeight)
	bar.ZIndex = 1
	bar.Parent = gui

	local x = PAD
	-- wide enough for the timestamp plus the range-end suffix
	local clockLabel = newLabel(bar, x, 204, Theme.accent)
	x += 204 + PAD

	local backBtn = newButton(bar, x, 34, "|<")
	x += 34 + 2
	local fwdBtn = newButton(bar, x, 34, ">|")
	x += 34 + PAD
	-- 86 wide: "|| playing" is the longest state this button ever holds
	local playBtn = newButton(bar, x, 86, "> auto")
	x += 86 + PAD
	local speedBtn = newButton(bar, x, 78, "1 bar/s")
	local speedFlyout = newFlyout(gui, "SpeedMenu", x, SPEED_MENU_W, speedOptions())
	x += 78 + PAD
	local stepBtn = newButton(bar, x, 82, "step 1m")
	local stepFlyout = newFlyout(gui, "StepMenu", x, STEP_MENU_W, stepOptions())
	x += 82 + PAD * 3

	local tfButtons: { [Timeframe]: TextButton } = {}
	for _, tf in ipairs(Types.TIMEFRAMES) do
		tfButtons[tf] = newButton(bar, x, TF_BTN_W, tf)
		x += TF_BTN_W + 2
	end

	local jumpBox, jumpGo, jumpPreset = newJumpGroup(bar)
	local tfOverlay, tfText, tfHint = newTfOverlay(gui)

	local self: Controls = setmetatable(
		{
			cbs = cbs,
			clockLabel = clockLabel,
			playBtn = playBtn,
			fwdBtn = fwdBtn,
			jumpBox = jumpBox,
			speedBtn = speedBtn,
			speedFlyout = speedFlyout,
			stepBtn = stepBtn,
			stepFlyout = stepFlyout,
			tfButtons = tfButtons,
			tfOverlay = tfOverlay,
			tfText = tfText,
			tfHint = tfHint,
			tf = "1m" :: Timeframe,
			playing = false,
			speed = Protocol.SPEEDS[1],
			atEnd = false,
			sessionDate = nil :: string?,
			jumpSeq = 0,
			stepMode = "1m",
			serverStepSize = "1m",
			tfBuffer = "",
			tfSeq = 0,
		} :: Fields,
		Controls
	)

	highlightTf(self)
	syncStep(self)
	syncSpeed(self)

	backBtn.Activated:Connect(function()
		cbs.send({ cmd = "stepBack" })
	end)
	fwdBtn.Activated:Connect(function()
		cbs.send({ cmd = "stepForward" })
	end)
	playBtn.Activated:Connect(function()
		cbs.send({ cmd = if self.playing then "pause" else "play" })
	end)
	speedBtn.Activated:Connect(function()
		setFlyoutOpen(self.speedFlyout, not self.speedFlyout.menu.Visible)
	end)
	stepBtn.Activated:Connect(function()
		setFlyoutOpen(self.stepFlyout, not self.stepFlyout.menu.Visible)
	end)
	-- Clicking anywhere else — including back on the button, which the scrim
	-- now covers — closes without choosing.
	speedFlyout.scrim.Activated:Connect(function()
		setFlyoutOpen(self.speedFlyout, false)
	end)
	stepFlyout.scrim.Activated:Connect(function()
		setFlyoutOpen(self.stepFlyout, false)
	end)
	for _, speed in ipairs(Protocol.SPEEDS) do
		speedFlyout.rows[tostring(speed)].Activated:Connect(function()
			pickSpeed(self, speed)
		end)
	end
	for value, row in pairs(stepFlyout.rows) do
		row.Activated:Connect(function()
			setStepMode(self, value)
		end)
	end
	for tf, btn in pairs(tfButtons) do
		btn.Activated:Connect(function()
			self:setTimeframe(tf)
		end)
	end
	jumpGo.Activated:Connect(function()
		doJump(self, jumpBox.Text)
	end)
	-- Only Enter commits: a click elsewhere on the HUD blurs the box too, and
	-- jumping the clock on that would be a rewind nobody asked for.
	jumpBox.FocusLost:Connect(function(enterPressed: boolean)
		if enterPressed then
			doJump(self, jumpBox.Text)
		end
	end)
	jumpPreset.Activated:Connect(function()
		jumpBox.Text = JUMP_PRESET
		doJump(self, JUMP_PRESET)
	end)
	wireKeyboard(self)

	return self
end

return Controls
