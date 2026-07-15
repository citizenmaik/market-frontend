#!/usr/bin/env python3
"""theme_scan.py — Theme Tracker producer. Schreibt public/themes.json."""
import json, sys
from datetime import datetime, timezone
import pandas as pd, yfinance as yf

THEMES = {
    "Genomics": "ARKG", "Cybersecurity": "CIBR", "Biotechnology": "XBI",
    "Airlines": "JETS", "Banks": "KRE", "HealthCare": "XLV", "Utilities": "XLU",
    "Industrials": "XLI", "Software": "IGV", "Bitcoin": "IBIT", "Transports": "IYT",
    "Aerospace": "ITA", "Social Media": "SOCL", "Retail": "XRT", "Real Estate": "XLRE",
    "Materials": "XLB", "Medical Devices": "IHI", "Home Construction": "ITB",
    "China Internet": "KWEB", "Semiconductors": "SMH", "AI": "AIQ",
    "Gold Miners": "GDX", "Robotics": "ROBO", "Growth Stocks": "IWF",
    "Silver Miners": "SIL", "Telecom": "XTL", "Quantum": "QTUM", "Steel": "SLX",
    "Oil & Gas": "XOP", "Solar": "TAN", "Bitcoin Miners": "WGMI",
    "Uranium": "URA", "Defense": "SHLD",
}

WINDOWS = {"1d": 1, "1w": 5, "2w": 10, "1m": 21, "3m": 63}
RS_WEIGHTS = {"1d": 0.10, "1w": 0.35, "2w": 0.25, "1m": 0.30}
RS_SCALE, OUT_PATH, SPARK_POINTS, BENCHMARK = 3.5, "public/themes.json", 21, "SPY"

def pct_change(series, lookback):
    s = series.dropna()
    if len(s) < lookback + 1: return None
    now, then = float(s.iloc[-1]), float(s.iloc[-1 - lookback])
    return None if then == 0 else round((now / then - 1.0) * 100.0, 2)

def ytd_change(series):
    s = series.dropna()
    if s.empty: return None
    ytd = s[s.index.year == s.index[-1].year]
    if len(ytd) < 2: return None
    return round((float(ytd.iloc[-1]) / float(ytd.iloc[0]) - 1.0) * 100.0, 2)

def rs_composite(perf):
    acc = 0.0
    for k, w in RS_WEIGHTS.items():
        v = perf.get(k)
        if v is None: return None
        acc += v * w
    return round(acc * RS_SCALE, 2)

def spark(series, points=SPARK_POINTS):
    s = series.dropna().iloc[-points:]
    if s.empty: return []
    base = float(s.iloc[0])
    return [] if base == 0 else [round((float(v) / base - 1.0) * 100.0, 2) for v in s]

def main():
    tickers = sorted(set(THEMES.values()) | {BENCHMARK})
    print(f"[theme_scan] downloading {len(tickers)} tickers ...", file=sys.stderr)
    raw = yf.download(tickers, period="1y", interval="1d", auto_adjust=True,
                      progress=False, group_by="column", threads=True)
    if raw.empty: raise SystemExit("[theme_scan] FATAL: empty download")
    close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw[["Close"]]

    bench_perf = {k: pct_change(close[BENCHMARK], lb) for k, lb in WINDOWS.items()} \
                 if BENCHMARK in close.columns else {}

    rows = []
    for theme, etf in THEMES.items():
        if etf not in close.columns:
            print(f"[theme_scan] WARN: {etf} ({theme}) missing", file=sys.stderr); continue
        s = close[etf]
        perf = {k: pct_change(s, lb) for k, lb in WINDOWS.items()}
        perf["ytd"] = ytd_change(s)
        b1m = bench_perf.get("1m")
        rs_ratio = round(perf["1m"] - b1m, 2) if perf.get("1m") is not None and b1m is not None else None
        rows.append({"theme": theme, "etf": etf, "perf": perf,
                     "rs_composite": rs_composite(perf), "rs_ratio": rs_ratio,
                     "spark": spark(s)})

    rows.sort(key=lambda r: (r["perf"].get("1m") is None, -(r["perf"].get("1m") or 0)))
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "benchmark": BENCHMARK, "benchmark_perf": bench_perf, "themes": rows}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"[theme_scan] wrote {OUT_PATH} ({len(rows)} themes)", file=sys.stderr)

if __name__ == "__main__":
    main()
