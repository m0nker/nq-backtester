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
	tfButtons: { [Timeframe]: TextButton },
	tf: Timeframe,
	playing: boolean,
	speed: number,
	-- "1m" pins stepping to the base resolution; "view" follows the chart
	-- timeframe. The server has no "view" mode, so the CONCRETE timeframe is
	-- what actually travels in setStepSize.
	stepMode: string,
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
	b.Font = Enum.Font.Code
	b.TextSize = 13
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
	l.Font = Enum.Font.Code
	l.TextSize = 13
	l.TextColor3 = color
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = ""
	l.Parent = parent
	return l
end

-- The concrete timeframe the server should step by, given the local mode.
local function stepSizeFor(self: Controls): string
	return if self.stepMode == "1m" then "1m" else self.tf
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
	local step = "step " .. msg.stepSize
	if self.stepBtn.Text ~= step then
		self.stepBtn.Text = step
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
			tfButtons = tfButtons,
			tf = "1m" :: Timeframe,
			playing = false,
			speed = Protocol.SPEEDS[1],
			stepMode = "1m",
		} :: Fields,
		Controls
	)

	highlightTf(self)

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
		self.stepMode = if self.stepMode == "1m" then "view" else "1m"
		cbs.send({ cmd = "setStepSize", stepSize = stepSizeFor(self) })
	end)
	for tf, btn in pairs(tfButtons) do
		btn.Activated:Connect(function()
			self:setTimeframe(tf)
		end)
	end
	wireKeyboard(self)

	return self
end

return Controls
