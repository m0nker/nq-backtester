--!strict
-- Bottom control bar. Every button only SENDS a Cmd; the visible state of the
-- transport comes back from the Clock remote. The client never advances time
-- itself — that is the whole basis of the port's anti-lookahead guarantee.
--
-- Timeframe is the one exception: it is a pure display choice, re-aggregated
-- locally from bars the server already revealed.
--
-- The keyboard bindings are the same commands as the buttons. Every one of
-- them is gated on GetFocusedTextBox() being nil: the order panel's fields
-- share this keyboard, and a space typed into a qty box must not toggle play.

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

-- Step size is either a concrete timeframe or this: "follow the chart". The
-- server has no such mode (Protocol), so "view" never travels — it only
-- decides which CONCRETE timeframe setStepSize carries.
local STEP_VIEW = "view"
local STEP_MENU_W = 86
local STEP_ROW_H = 22
local STEP_MENU_PAD = 3

-- Timeframe hotkeys, TradingView-style: the digit row walks the ladder. Bound
-- here rather than next to the buttons so the two can never disagree about
-- which key means what.
local TF_HOTKEYS: { [Enum.KeyCode]: Timeframe } = {
	[Enum.KeyCode.One] = "1m",
	[Enum.KeyCode.Two] = "2m",
	[Enum.KeyCode.Three] = "3m",
	[Enum.KeyCode.Four] = "4m",
	[Enum.KeyCode.Five] = "5m",
	[Enum.KeyCode.Six] = "15m",
	[Enum.KeyCode.Seven] = "30m",
	[Enum.KeyCode.Eight] = "1h",
	[Enum.KeyCode.Nine] = "4h",
	[Enum.KeyCode.Zero] = "1D",
}

local Controls = {}
Controls.__index = Controls

export type Callbacks = {
	send: Send,
	setTimeframe: (Timeframe) -> (),
}

type Fields = {
	cbs: Callbacks,
	clockLabel: TextLabel,
	playBtn: TextButton,
	speedBtn: TextButton,
	stepBtn: TextButton,
	stepMenu: Frame,
	stepScrim: TextButton,
	stepRows: { [string]: TextButton },
	tfButtons: { [Timeframe]: TextButton },
	tf: Timeframe,
	playing: boolean,
	speed: number,
	-- A concrete Types.TIMEFRAMES value pins stepping to that timeframe;
	-- STEP_VIEW follows the chart's. Either way the CONCRETE timeframe is what
	-- travels in setStepSize.
	stepMode: string,
	-- what the SERVER last said it is stepping by; the button reports this
	-- rather than the last click, so a rejected setStepSize cannot lie
	serverStepSize: string,
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

-- The concrete timeframe the server should step by, given the local mode.
local function stepSizeFor(self: Controls): string
	return if self.stepMode == STEP_VIEW then self.tf else self.stepMode
end

-- The button names the MODE ("view" is a mode, not a size); every concrete
-- mode names the size the server confirmed.
local function syncStep(self: Controls)
	local text = "step " .. (if self.stepMode == STEP_VIEW then STEP_VIEW else self.serverStepSize)
	if self.stepBtn.Text ~= text then
		self.stepBtn.Text = text
	end
	for value, row in pairs(self.stepRows) do
		styleButton(row, value == self.stepMode)
	end
end

local function setStepMenuOpen(self: Controls, open: boolean)
	self.stepMenu.Visible = open
	self.stepScrim.Visible = open
end

local function setStepMode(self: Controls, mode: string)
	self.stepMode = mode
	setStepMenuOpen(self, false)
	syncStep(self)
	self.cbs.send({ cmd = "setStepSize", stepSize = stepSizeFor(self) })
end

-- The menu is parented to the HUD ScreenGui, not to the control bar: it opens
-- UPWARD out of the bar's bounds, and the scrim that dismisses it has to cover
-- the whole screen. Rows are built once — the option list is static.
local function newStepMenu(gui: ScreenGui, x: number): (Frame, TextButton, { [string]: TextButton })
	local scrim = Instance.new("TextButton")
	scrim.Name = "StepMenuScrim"
	scrim.BorderSizePixel = 0
	scrim.BackgroundTransparency = 1
	scrim.AutoButtonColor = false
	scrim.Text = ""
	scrim.Size = UDim2.fromScale(1, 1)
	scrim.ZIndex = 19
	scrim.Visible = false
	scrim.Parent = gui

	local options: { string } = { STEP_VIEW }
	for _, tf in ipairs(Types.TIMEFRAMES) do
		table.insert(options, tf)
	end

	local menu = Instance.new("Frame")
	menu.Name = "StepMenu"
	menu.BorderSizePixel = 0
	menu.BackgroundColor3 = Theme.border
	menu.AnchorPoint = Vector2.new(0, 1)
	menu.Position = UDim2.new(0, x, 1, -(Theme.controlBarHeight + 2))
	menu.Size = UDim2.fromOffset(STEP_MENU_W, #options * STEP_ROW_H + STEP_MENU_PAD * 2)
	menu.ZIndex = 20
	menu.Visible = false
	menu.Active = true
	menu.Parent = gui

	local rows: { [string]: TextButton } = {}
	for i, value in ipairs(options) do
		local row = Instance.new("TextButton")
		row.Name = value
		row.BorderSizePixel = 0
		row.Position = UDim2.fromOffset(STEP_MENU_PAD, STEP_MENU_PAD + (i - 1) * STEP_ROW_H)
		row.Size = UDim2.fromOffset(STEP_MENU_W - STEP_MENU_PAD * 2, STEP_ROW_H)
		row.Font = Theme.fontUi
		row.TextSize = Theme.textMd
		row.Text = value
		row.AutoButtonColor = true
		row.ZIndex = 21
		row.Parent = menu
		styleButton(row, false)
		rows[value] = row
	end
	return menu, scrim, rows
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

-- The arrow keys walk the ladder and stop at its ends; the button wraps.
local function nudgeSpeed(self: Controls, dir: number)
	local idx = math.clamp(speedIndex(self) + dir, 1, #Protocol.SPEEDS)
	local speed = Protocol.SPEEDS[idx]
	if speed ~= self.speed then
		self.cbs.send({ cmd = "setSpeed", speed = speed })
	end
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
			self.cbs.send({ cmd = if self.playing then "pause" else "play" })
		end
		return Enum.ContextActionResult.Sink
	end, false, Enum.KeyCode.Space)

	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if processed or UserInputService:GetFocusedTextBox() ~= nil then
			return
		end
		local key = input.KeyCode
		local tf = TF_HOTKEYS[key]
		if tf ~= nil then
			self:setTimeframe(tf)
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

-- Authoritative transport state: the bar renders what the server reports, not
-- what the last click asked for.
function Controls.onClock(self: Controls, msg: Protocol.Clock)
	local t = Et.formatET(msg.t, true)
	if self.clockLabel.Text ~= t then
		self.clockLabel.Text = t
	end
	if self.playing ~= msg.playing then
		self.playing = msg.playing
		self.playBtn.Text = if msg.playing then "|| pause" else "> play"
		styleButton(self.playBtn, msg.playing)
	end
	if self.speed ~= msg.speed then
		self.speed = msg.speed
		self.speedBtn.Text = string.format("%d bar/s", msg.speed)
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
	local clockLabel = newLabel(bar, x, 178, Theme.accent)
	x += 178 + PAD

	local backBtn = newButton(bar, x, 34, "|<")
	x += 34 + 2
	local fwdBtn = newButton(bar, x, 34, ">|")
	x += 34 + PAD
	local playBtn = newButton(bar, x, 78, "> play")
	x += 78 + PAD
	local speedBtn = newButton(bar, x, 78, "1 bar/s")
	x += 78 + PAD
	local stepBtn = newButton(bar, x, 82, "step 1m")
	local stepMenu, stepScrim, stepRows = newStepMenu(gui, x)
	x += 82 + PAD * 3

	local tfButtons: { [Timeframe]: TextButton } = {}
	for _, tf in ipairs(Types.TIMEFRAMES) do
		tfButtons[tf] = newButton(bar, x, TF_BTN_W, tf)
		x += TF_BTN_W + 2
	end

	local self: Controls = setmetatable(
		{
			cbs = cbs,
			clockLabel = clockLabel,
			playBtn = playBtn,
			speedBtn = speedBtn,
			stepBtn = stepBtn,
			stepMenu = stepMenu,
			stepScrim = stepScrim,
			stepRows = stepRows,
			tfButtons = tfButtons,
			tf = "1m" :: Timeframe,
			playing = false,
			speed = Protocol.SPEEDS[1],
			stepMode = "1m",
			serverStepSize = "1m",
		} :: Fields,
		Controls
	)

	highlightTf(self)
	syncStep(self)

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
		cbs.send({ cmd = "setSpeed", speed = Protocol.SPEEDS[speedIndex(self) % #Protocol.SPEEDS + 1] })
	end)
	stepBtn.Activated:Connect(function()
		setStepMenuOpen(self, not self.stepMenu.Visible)
	end)
	-- Clicking anywhere else — including back on the button, which the scrim
	-- now covers — closes without choosing.
	stepScrim.Activated:Connect(function()
		setStepMenuOpen(self, false)
	end)
	for value, row in pairs(stepRows) do
		row.Activated:Connect(function()
			setStepMode(self, value)
		end)
	end
	for tf, btn in pairs(tfButtons) do
		btn.Activated:Connect(function()
			self:setTimeframe(tf)
		end)
	end
	wireKeyboard(self)

	return self
end

return Controls
