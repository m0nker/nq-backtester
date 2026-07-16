# Inspect DBN metadata + first records of each Databento file.
import io
import json
import sys

import zstandard
from databento_dbn import DBNDecoder, Metadata

FILES = {
    "NQ-1s": r"C:\backtester\newdata\GLBX-20260714-5J7TRQDWKM\glbx-mdp3-20250301-20260713.ohlcv-1s.dbn.zst",
    "ES-1s": r"C:\backtester\newdata\GLBX-20260714-MMGXWVJED3\glbx-mdp3-20250601-20260713.ohlcv-1s.dbn.zst",
    "ES-1m": r"C:\backtester\newdata\GLBX-20260714-WANQ6YK797\glbx-mdp3-20150606-20250602.ohlcv-1m.dbn.zst",
}

for name, path in FILES.items():
    dctx = zstandard.ZstdDecompressor()
    decoder = DBNDecoder()
    meta = None
    records = []
    with open(path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            while len(records) < 4:
                chunk = reader.read(1 << 16)
                if not chunk:
                    break
                decoder.write(chunk)
                for rec in decoder.decode():
                    if isinstance(rec, Metadata):
                        meta = rec
                    else:
                        records.append(rec)
                        if len(records) >= 4:
                            break
    print(f"=== {name} ===")
    if meta is not None:
        print("symbols:", meta.symbols, "stype_in:", meta.stype_in, "stype_out:", meta.stype_out)
        print("start:", meta.start, "end:", meta.end)
        m = meta.mappings
        print("mappings type:", type(m).__name__, "len:", len(m) if hasattr(m, "__len__") else "?")
        # show a couple of mapping entries
        if isinstance(m, dict):
            for i, (k, v) in enumerate(m.items()):
                print("  map:", k, "->", v[:2] if isinstance(v, list) else v)
                if i >= 2:
                    break
    for r in records[:3]:
        print("rec:", type(r).__name__, "iid:", r.instrument_id, "ts:", r.ts_event, "o:", r.open, "c:", r.close, "v:", r.volume)
    print()
