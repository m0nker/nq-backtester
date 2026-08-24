--!strict
-- Packed binary bar-chunk codec, v1. The SINGLE source of truth for the byte
-- layout; roblox/tools/prepareData.ts must emit exactly this format (the
-- Codec parity fixture pins it).
--
-- All integers little-endian (Luau buffer native order).
--
--   offset  size  field
--   0       4     magic 0x4B42514E ("NQBK" as bytes)
--   4       1     version (1)
--   5       3     reserved (0)
--   8       4     barCount (u32)
--   12      8     tickSize (f64), e.g. 0.25
--   20      24*N  bars: t (u32 epoch sec UTC), o, h, l, c (i32 TICK counts:
--                 price = ticks * tickSize), v (u32)
--
-- Prices travel as integer tick counts so every price is exact — no float
-- accumulation anywhere between the preprocessing tool and the chart.

local Types = require(script.Parent.Parent.Types)

type Bar = Types.Bar

local M = {}

M.MAGIC = 0x4B42514E
M.VERSION = 1
M.HEADER_SIZE = 20
M.BAR_SIZE = 24

function M.encode(bars: { Bar }, tickSize: number): buffer
	local n = #bars
	local buf = buffer.create(M.HEADER_SIZE + M.BAR_SIZE * n)
	buffer.writeu32(buf, 0, M.MAGIC)
	buffer.writeu8(buf, 4, M.VERSION)
	buffer.writeu32(buf, 8, n)
	buffer.writef64(buf, 12, tickSize)
	local off = M.HEADER_SIZE
	for _, b in ipairs(bars) do
		buffer.writeu32(buf, off, b.t)
		-- +0.5 floor = round; tick counts can be negative after normalization
		-- shifts, hence i32. All inputs are exact tick multiples.
		buffer.writei32(buf, off + 4, math.floor(b.o / tickSize + 0.5))
		buffer.writei32(buf, off + 8, math.floor(b.h / tickSize + 0.5))
		buffer.writei32(buf, off + 12, math.floor(b.l / tickSize + 0.5))
		buffer.writei32(buf, off + 16, math.floor(b.c / tickSize + 0.5))
		buffer.writeu32(buf, off + 20, b.v)
		off += M.BAR_SIZE
	end
	return buf
end

-- Header accessor so consumers never hardcode the byte layout themselves.
function M.tickSizeOf(buf: buffer): number
	assert(buffer.readu32(buf, 0) == M.MAGIC, "BarCodec: bad magic")
	return buffer.readf64(buf, 12)
end

function M.decode(buf: buffer): { Bar }
	assert(buffer.readu32(buf, 0) == M.MAGIC, "BarCodec: bad magic")
	assert(buffer.readu8(buf, 4) == M.VERSION, "BarCodec: unsupported version")
	local n = buffer.readu32(buf, 8)
	local tickSize = buffer.readf64(buf, 12)
	assert(buffer.len(buf) >= M.HEADER_SIZE + M.BAR_SIZE * n, "BarCodec: truncated")
	local bars = table.create(n)
	local off = M.HEADER_SIZE
	for i = 1, n do
		bars[i] = {
			t = buffer.readu32(buf, off),
			o = buffer.readi32(buf, off + 4) * tickSize,
			h = buffer.readi32(buf, off + 8) * tickSize,
			l = buffer.readi32(buf, off + 12) * tickSize,
			c = buffer.readi32(buf, off + 16) * tickSize,
			v = buffer.readu32(buf, off + 20),
		}
		off += M.BAR_SIZE
	end
	return bars
end

-- Re-encode a slice of already-decoded bars (server -> client reveal packets
-- use the same framed format so there is exactly one decode path).
function M.encodeSlice(bars: { Bar }, fromIdx: number, toIdx: number, tickSize: number): buffer
	local slice = table.create(math.max(0, toIdx - fromIdx + 1))
	for i = fromIdx, toIdx do
		table.insert(slice, bars[i])
	end
	return M.encode(slice, tickSize)
end

return M
