--!strict
-- Golden-fixture parity runner: replays every case recorded by
-- `roblox/tools/dumpFixtures.ts` against the Luau port and reports divergence.
--
-- The fixtures are the contract between the two engines. A failure here means
-- the port disagrees with the TS reference — fix the port, never the fixture.
-- Regenerate fixtures only when the web engine itself changed.
--
-- Numbers compare with a relative tolerance because the values crossed JSON;
-- the exact delta is always reported so genuine (non-noise) drift is visible.
--
-- Usage (Studio command bar / a test Script):
--   require(game.ReplicatedStorage.Tests.Parity).run()

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Trading = Shared:WaitForChild("Trading")

local Types = require(Shared:WaitForChild("Types"))
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Aggregate = require(Shared:WaitForChild("Replay"):WaitForChild("Aggregate"))
local ContractMath = require(Trading:WaitForChild("ContractMath"))
local Fills = require(Trading:WaitForChild("Fills"))
local Engine = require(Trading:WaitForChild("Engine"))

local Fixtures = script.Parent:WaitForChild("fixtures")
local EtFx = require(Fixtures:WaitForChild("Et")) :: any
local AggregateFx = require(Fixtures:WaitForChild("Aggregate")) :: any
local FillsFx = require(Fixtures:WaitForChild("Fills")) :: any
local EngineFx = require(Fixtures:WaitForChild("Engine")) :: any
local ContractMathFx = require(Fixtures:WaitForChild("ContractMath")) :: any

type Bar = Types.Bar

-- JSON round-trip noise only; anything larger is a real divergence.
local REL_TOL = 1.0e-9
-- Fields reported per failing case, and cases printed in full, respectively.
local MAX_FIELDS_PER_CASE = 6
local MAX_PRINTED_FAILURES = 10

-- ---------------------------------------------------------------------------
-- deep compare
-- ---------------------------------------------------------------------------

local function childPath(path: string, key: any): string
	if typeof(key) == "number" then
		return `{path}[{key}]`
	end
	if path == "" then
		return tostring(key)
	end
	return `{path}.{tostring(key)}`
end

local function keyLess(a: any, b: any): boolean
	local ta, tb = typeof(a), typeof(b)
	if ta ~= tb then
		return ta == "number"
	end
	if ta == "number" then
		return (a :: number) < (b :: number)
	end
	return tostring(a) < tostring(b)
end

type Budget = { n: number }

local function deepCompare(path: string, expected: any, actual: any, out: { string }, budget: Budget)
	if budget.n <= 0 then
		return
	end
	if expected == nil and actual == nil then
		return
	end

	local where = if path == "" then "<root>" else path
	local te, ta = typeof(expected), typeof(actual)
	if te ~= ta then
		table.insert(out, `{where}: expected {te} {tostring(expected)}, got {ta} {tostring(actual)}`)
		budget.n -= 1
		return
	end

	if te == "number" then
		local e, a = expected :: number, actual :: number
		if e == a then
			return
		end
		local diff = math.abs(e - a)
		local scale = math.max(math.abs(e), math.abs(a))
		if scale > 0 and diff / scale <= REL_TOL then
			return
		end
		table.insert(out, `{where}: expected {e}, got {a} (delta {diff})`)
		budget.n -= 1
		return
	end

	if te == "table" then
		local keys: { any } = {}
		local seen: { [any]: boolean } = {}
		for k in pairs(expected :: any) do
			table.insert(keys, k)
			seen[k] = true
		end
		for k in pairs(actual :: any) do
			if not seen[k] then
				table.insert(keys, k)
			end
		end
		table.sort(keys, keyLess)
		for _, k in keys do
			deepCompare(childPath(path, k), (expected :: any)[k], (actual :: any)[k], out, budget)
			if budget.n <= 0 then
				return
			end
		end
		return
	end

	if expected ~= actual then
		table.insert(out, `{where}: expected {tostring(expected)}, got {tostring(actual)}`)
		budget.n -= 1
	end
end

-- ---------------------------------------------------------------------------
-- suites
-- ---------------------------------------------------------------------------

type Suite = { name: string, passed: number, failed: number, failures: { string } }

local function newSuite(name: string): Suite
	return { name = name, passed = 0, failed = 0, failures = {} }
end

local function check(suite: Suite, caseName: string, expected: any, actual: any)
	local msgs: { string } = {}
	deepCompare("", expected, actual, msgs, { n = MAX_FIELDS_PER_CASE })
	if #msgs == 0 then
		suite.passed += 1
	else
		suite.failed += 1
		table.insert(suite.failures, `[{suite.name}] {caseName}\n    ` .. table.concat(msgs, "\n    "))
	end
end

-- Fixtures serialize bars compactly as [t, o, h, l, c, v]; Luau arrays are
-- 1-based, so t is index 1.
local function decBar(a: { number }): Bar
	return { t = a[1], o = a[2], h = a[3], l = a[4], c = a[5], v = a[6] }
end

local function decBars(list: { { number } }): { Bar }
	local out: { Bar } = {}
	for i, a in list do
		out[i] = decBar(a)
	end
	return out
end

local function encBar(b: Bar): { number }
	return { b.t, b.o, b.h, b.l, b.c, b.v }
end

local function sortedKeys(t: { [string]: any }): { string }
	local keys: { string } = {}
	for k in pairs(t) do
		table.insert(keys, k)
	end
	table.sort(keys)
	return keys
end

local function runEt(): Suite
	local suite = newSuite("Et")

	for i, c in EtFx.offsetCases do
		local ts = c[1] :: number
		local actual: { any } = {
			ts,
			Et.etOffsetSec(ts),
			Et.tradingDayStartSec(ts),
			Et.tradingWeekStartSec(ts),
			Et.monthBucketStartSec(ts),
			Et.tradingDateOf(ts),
		}
		check(suite, `offsetCases[{i}] ts={ts}`, c, actual)
	end

	for i, w in EtFx.wallToUtc do
		local y, mo, d, h, mi, s = w[1], w[2], w[3], w[4], w[5], w[6]
		check(suite, `wallToUtc[{i}] {y}-{mo}-{d} {h}:{mi}:{s}`, w[7], Et.etWallToUtc(y, mo, d, h, mi, s))
	end

	for i, m in EtFx.monthEnd do
		check(suite, `monthEnd[{i}] start={m[1]}`, m[2], Et.monthBucketEndSec(m[1]))
	end

	return suite
end

local function runAggregate(): Suite
	local suite = newSuite("Aggregate")

	for _, scenario in AggregateFx.scenarios do
		local base = decBars(scenario.bars)
		for _, tf in sortedKeys(scenario.results) do
			local expected = scenario.results[tf]
			local produced = Aggregate.aggregate(base, tf :: any, scenario.baseSec)
			local actual: { { number } } = {}
			for i, b in produced do
				actual[i] = encBar(b)
			end
			check(suite, `{scenario.name}/{tf}`, expected, actual)
		end
	end

	return suite
end

local function runFills(): Suite
	local suite = newSuite("Fills")

	for _, case in FillsFx.cases do
		-- Same contract as the TS SecondsResolver: nil when the case has no 1s
		-- coverage at all, otherwise the (possibly empty) bars in [from, to).
		local secondsFor: ((number, number) -> { Bar }?)? = nil
		if case.seconds ~= nil then
			local secs = decBars(case.seconds)
			secondsFor = function(fromTs: number, toTs: number): { Bar }?
				local window: { Bar } = {}
				for _, b in secs do
					if b.t >= fromTs and b.t < toTs then
						table.insert(window, b)
					end
				end
				return window
			end
		end

		local actual = Fills.simulateBar(case.orders :: any, decBar(case.bar), secondsFor, case.barDurSec)
		check(suite, case.name, case.expected, actual)
	end

	return suite
end

local function runEngine(): Suite
	local suite = newSuite("Engine")

	for _, case in EngineFx.cases do
		local state = Engine.deriveState(case.events :: any)
		local ids: { string } = {}
		for i, o in state.workingOrders do
			ids[i] = o.id
		end
		check(suite, case.name, case.expected, {
			position = state.position,
			realizedPts = state.realizedPts,
			realizedUsd = state.realizedUsd,
			startingBalance = state.startingBalance,
			voidedCount = state.voidedCount,
			workingOrderIds = ids,
			workingOrders = state.workingOrders,
			trades = state.trades,
		})
	end

	return suite
end

local function runContractMath(): Suite
	local suite = newSuite("ContractMath")

	for i, c in ContractMathFx.quantize do
		check(suite, `quantizeQty[{i}]({c[1]})`, c[2], ContractMath.quantizeQty(c[1]))
	end
	for i, c in ContractMathFx.roundToTick do
		check(suite, `roundToTick[{i}]({c[1]})`, c[2], ContractMath.roundToTick(c[1]))
	end
	for i, c in ContractMathFx.ptsToUsd do
		check(suite, `ptsToUsd[{i}]({c[1]}, {c[2]})`, c[3], ContractMath.ptsToUsd(c[1], c[2]))
	end

	return suite
end

-- Pins the TS packer (tools/prepareData.ts) to the Luau BarCodec byte-for-
-- byte. Skips quietly when the fixture hasn't been generated yet; skips with
-- a warn if EncodingService is unavailable (pre-v697 Studio).
local function runCodec(): Suite?
	local fixture = Fixtures:FindFirstChild("Codec")
	if fixture == nil then
		return nil
	end
	local fx = require(fixture) :: any
	local BarCodec = require(Shared:WaitForChild("Data"):WaitForChild("BarCodec"))

	local ok, enc = pcall(function()
		return game:GetService("EncodingService")
	end)
	if not ok then
		warn("Parity: EncodingService unavailable — Codec suite skipped")
		return nil
	end

	local suite = newSuite("Codec")
	local bars = decBars(fx.bars)

	-- decode: TS-packed bytes -> bars. EncodingService's Base64 APIs take and
	-- return BUFFERS, never strings.
	local packed = (enc :: any):Base64Decode(buffer.fromstring(fx.base64)) :: buffer
	local decoded = BarCodec.decode(packed)
	local decodedEnc: { { number } } = {}
	for i, b in decoded do
		decodedEnc[i] = encBar(b)
	end
	check(suite, "decode(tsBytes)", fx.bars, decodedEnc)

	-- encode: bars -> bytes must equal the TS packer's output exactly
	local reEncoded = BarCodec.encode(bars, fx.tickSize)
	check(suite, "encode(bars)", fx.base64, buffer.tostring((enc :: any):Base64Encode(reEncoded)))

	return suite
end

-- ---------------------------------------------------------------------------

local Parity = {}

export type Result = { passed: number, failed: number, failures: { string } }

function Parity.run(): Result
	local suites = { runContractMath(), runEt(), runAggregate(), runFills(), runEngine() }
	local codec = runCodec()
	if codec ~= nil then
		table.insert(suites, codec)
	end

	local total: Result = { passed = 0, failed = 0, failures = {} }
	print("=== Parity ===")
	for _, s in suites do
		total.passed += s.passed
		total.failed += s.failed
		for _, f in s.failures do
			table.insert(total.failures, f)
		end
		print(`  {s.name}: {s.passed} passed, {s.failed} failed`)
	end

	if total.failed > 0 then
		local shown = math.min(#total.failures, MAX_PRINTED_FAILURES)
		warn(`--- first {shown} of {#total.failures} failing cases ---`)
		for i = 1, shown do
			warn(total.failures[i])
		end
	end
	print(`=== {total.passed} passed, {total.failed} failed ===`)

	return total
end

return Parity
