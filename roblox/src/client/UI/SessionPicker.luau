--!strict
-- Session date picker: a modal list of the dates SessionInfo offered. Picking
-- one sends startSession and closes; the "new session" button reopens it.
--
-- The list is rebuilt only when the date set changes (a SessionInfo arrival),
-- never per frame, so building rows with Instance.new here is fine.

local SessionPicker = {}
SessionPicker.__index = SessionPicker

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local ROW_H = 26
local PANEL_W = 260
local PANEL_H = 380

type Fields = {
	modal: Frame,
	list: ScrollingFrame,
	dates: { string },
	onPick: (string) -> (),
}

export type SessionPicker = typeof(setmetatable({} :: Fields, SessionPicker))

function SessionPicker.show(self: SessionPicker)
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
	for _, child in ipairs(self.list:GetChildren()) do
		if child:IsA("TextButton") then
			child:Destroy()
		end
	end
	for i, date in ipairs(dates) do
		local row = Instance.new("TextButton")
		row.Name = date
		row.BorderSizePixel = 0
		row.BackgroundColor3 = Theme.panel
		row.TextColor3 = Theme.text
		row.Font = Theme.fontUi
		row.TextSize = Theme.textMd
		row.Text = date
		row.Position = UDim2.fromOffset(0, (i - 1) * (ROW_H + 2))
		row.Size = UDim2.new(1, -12, 0, ROW_H)
		row.ZIndex = 12
		row.Parent = self.list
		row.Activated:Connect(function()
			self:hide()
			self.onPick(date)
		end)
	end
	self.list.CanvasSize = UDim2.fromOffset(0, #dates * (ROW_H + 2))
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
	panel.Parent = modal

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.BorderSizePixel = 0
	title.Position = UDim2.fromOffset(12, 8)
	title.Size = UDim2.new(1, -24, 0, 20)
	title.Font = Theme.fontUiMedium
	title.TextSize = Theme.textLg
	title.TextColor3 = Theme.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = "pick a session"
	title.ZIndex = 12
	title.Parent = panel

	local list = Instance.new("ScrollingFrame")
	list.Name = "Dates"
	list.BorderSizePixel = 0
	list.BackgroundTransparency = 1
	list.Position = UDim2.fromOffset(8, 34)
	list.Size = UDim2.new(1, -16, 1, -42)
	list.CanvasSize = UDim2.fromOffset(0, 0)
	list.ScrollBarThickness = 6
	list.ZIndex = 11
	list.Parent = panel

	local openBtn = Instance.new("TextButton")
	openBtn.Name = "NewSession"
	openBtn.BorderSizePixel = 0
	openBtn.AnchorPoint = Vector2.new(1, 0)
	openBtn.Position = UDim2.new(1, -8, 0, 8)
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
			list = list,
			dates = {},
			onPick = onPick,
		} :: Fields,
		SessionPicker
	)

	openBtn.Activated:Connect(function()
		self:show()
	end)

	return self
end

return SessionPicker
