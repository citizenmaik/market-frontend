#!/usr/bin/env python3
"""
Breadth Scanner — Market Dashboard
==================================
Berechnet den Multi-Universe Breadth Snapshot (NYSE / RSP / QQQE / IWM) aus den
Einzelwerten der jeweiligen Indexmitglieder und schreibt das Ergebnis nach
./breadth.json (Repo-Root). Das Dashboard liest diese Datei via fetch('/breadth.json').

Kennzahlen je Universum:
  A/D        = Advancer / Decliner (heute vs. Vortagesschluss)
  52w H/L    = Titel auf 52-Wochen-Hoch / -Tief (Close-basiert)
  Up/Dn 4%   = Titel mit Tagesbewegung >= +4% / <= -4%
  %>50d      = Anteil > 50-Tage-SMA
  %>200d     = Anteil > 200-Tage-SMA
  Rank       = eigener Composite-Score in [-100, +100] (siehe WEIGHTS unten)

Constituent-Quellen (jeweils mit Override):
  Lege optional constituents/<key>.txt an (ein Ticker pro Zeile, '#' = Kommentar),
  dann wird die Datei statt der dynamischen Quelle genutzt — nützlich, falls eine
  Web-Quelle mal ausfällt.  keys: nyse, rsp, qqqe, iwm

Abhängigkeiten: yfinance pandas numpy lxml requests
"""

import io
import os
import json
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT_PATH = os.path.join(REPO, "breadth.json")
CONST_DIR = os.path.join(REPO, "constituents")

UA = {"User-Agent": "Mozilla/5.0"}

# ── Breadth-Rank Gewichte (Summe = 1.0, jede Komponente in [-100,+100]) ────────
# Tuning: kurzfristige Thrust-Signale (A/D, Up/Dn 4%) etwas höher gewichtet als
# die trägen MA-Komponenten. Frei anpassbar.
WEIGHTS = {
    "ad":     0.25,   # (adv - dec) / (adv + dec)
    "hl":     0.15,   # (newHigh - newLow) / (newHigh + newLow)
    "up4":    0.25,   # (up4 - dn4) / (up4 + dn4)
    "pct50":  0.20,   # (pct50 - 50) * 2
    "pct200": 0.15,   # (pct200 - 50) * 2
}


# ═══════════════════════════════════════════════════════════════════════════
# Constituent-Loader
# ═══════════════════════════════════════════════════════════════════════════
def _yahooify(sym):
    """Yahoo nutzt '-' statt '.' (z.B. BRK.B -> BRK-B)."""
    return str(sym).strip().upper().replace(".", "-")


def _from_file(key):
    """Override aus constituents/<key>.txt, falls vorhanden."""
    p = os.path.join(CONST_DIR, key + ".txt")
    if os.path.exists(p):
        with open(p) as f:
            syms = [_yahooify(l) for l in f if l.strip() and not l.startswith("#")]
        print(f"  [{key}] override-Datei: {len(syms)} Ticker")
        return syms
    return None


def load_sp500():  # RSP = S&P 500 Equal Weight -> S&P-500-Konstituenten
    ov = _from_file("rsp")
    if ov:
        return ov
    tabs = pd.read_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
    df = tabs[0]
    return [_yahooify(s) for s in df["Symbol"].tolist()]


def load_nasdaq100():  # QQQE = NASDAQ-100 Equal Weight
    ov = _from_file("qqqe")
    if ov:
        return ov
    tabs = pd.read_html("https://en.wikipedia.org/wiki/Nasdaq-100")
    for t in tabs:
        for col in ("Ticker", "Symbol"):
            if col in t.columns:
                vals = [_yahooify(s) for s in t[col].tolist()]
                if 80 <= len(vals) <= 110:  # Plausibilitätscheck
                    return vals
    raise RuntimeError("Nasdaq-100-Tabelle nicht gefunden")


def load_russell2000():  # IWM = iShares Russell 2000 -> Holdings-CSV
    ov = _from_file("iwm")
    if ov:
        return ov
    url = ("https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/"
           "1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund")
    r = requests.get(url, timeout=60, headers=UA)
    r.raise_for_status()
    lines = r.text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.lower().lstrip('"').startswith("ticker"))
    df = pd.read_csv(io.StringIO("\n".join(lines[start:])))
    tick_col = next(c for c in df.columns if str(c).strip().lower() == "ticker")
    syms = []
    for s in df[tick_col].tolist():
        s = _yahooify(s)
        if s and s not in ("-", "NAN", "CASH") and s.isalnum() is False:
            # allow hyphen (class shares); reject blanks/cash rows
            pass
        if s and s not in ("-", "NAN", "CASH") and 1 <= len(s) <= 6 and s.replace("-", "").isalpha():
            syms.append(s)
    return syms


def load_nyse():  # NYSE Composite -> NYSE-gelistete Common Stocks
    ov = _from_file("nyse")
    if ov:
        return ov
    url = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
    txt = requests.get(url, timeout=30, headers=UA).text
    df = pd.read_csv(io.StringIO(txt), sep="|")
    df = df.dropna(subset=["Exchange"])
    df = df[df["Exchange"] == "N"]                          # N = NYSE
    df = df[(df["ETF"] == "N") & (df["Test Issue"] == "N")]  # keine ETFs / Test-Issues
    syms = []
    for s in df["ACT Symbol"].tolist():
        s = _yahooify(s)
        if s and "$" not in s and s.replace("-", "").isalpha() and 1 <= len(s) <= 6:
            syms.append(s)
    return syms


# ═══════════════════════════════════════════════════════════════════════════
# Daten laden + Kennzahlen
# ═══════════════════════════════════════════════════════════════════════════
def batch_download(tickers, period="1y", batch=200):
    """Lädt Tagesdaten in Batches. Gibt {ticker: DataFrame(Close/High/Low)} zurück."""
    tickers = sorted(set(tickers))
    frames = {}
    for i in range(0, len(tickers), batch):
        chunk = tickers[i:i + batch]
        try:
            df = yf.download(chunk, period=period, interval="1d", group_by="ticker",
                             auto_adjust=False, threads=True, progress=False)
        except Exception as e:
            print(f"    batch {i}-{i+len(chunk)} Fehler: {e}")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            lvl0 = set(df.columns.get_level_values(0))
            for t in chunk:
                if t in lvl0:
                    frames[t] = df[t]
        elif len(chunk) == 1:
            frames[chunk[0]] = df
    return frames


def universe_metrics(frames):
    adv = dec = nh = nl = up4 = dn4 = 0
    above50 = above200 = n50 = n200 = total = 0
    for _, df in frames.items():
        if "Close" not in df:
            continue
        c = df["Close"].dropna()
        if len(c) < 2:
            continue
        total += 1
        last = float(c.iloc[-1])
        prev = float(c.iloc[-2])
        chg = (last / prev - 1) * 100 if prev else 0.0

        if last > prev:
            adv += 1
        elif last < prev:
            dec += 1

        if chg >= 4:
            up4 += 1
        elif chg <= -4:
            dn4 += 1

        win = c.iloc[-252:] if len(c) >= 252 else c   # 52 Wochen
        if last >= float(win.max()):
            nh += 1
        if last <= float(win.min()):
            nl += 1

        if len(c) >= 50:
            n50 += 1
            if last > float(c.iloc[-50:].mean()):
                above50 += 1
        if len(c) >= 200:
            n200 += 1
            if last > float(c.iloc[-200:].mean()):
                above200 += 1

    return {
        "total": total, "adv": adv, "dec": dec, "nh": nh, "nl": nl,
        "up4": up4, "dn4": dn4,
        "pct50": round(100 * above50 / n50, 1) if n50 else None,
        "pct200": round(100 * above200 / n200, 1) if n200 else None,
    }


def _signed_ratio(a, b):
    return 100.0 * (a - b) / (a + b) if (a + b) > 0 else 0.0


def breadth_rank(m, w=WEIGHTS):
    ad = _signed_ratio(m["adv"], m["dec"])
    hl = _signed_ratio(m["nh"], m["nl"])
    u4 = _signed_ratio(m["up4"], m["dn4"])
    p50 = ((m["pct50"] if m["pct50"] is not None else 50) - 50) * 2
    p200 = ((m["pct200"] if m["pct200"] is not None else 50) - 50) * 2
    r = w["ad"]*ad + w["hl"]*hl + w["up4"]*u4 + w["pct50"]*p50 + w["pct200"]*p200
    return round(max(-100.0, min(100.0, r)), 1)


def _pct(v):
    return f"{v:.0f}%" if v is not None else "—"


def build_row(name, m):
    return {
        "u": name,
        "ad": f"{m['adv']}/{m['dec']}",
        "hl": f"{m['nh']}/{m['nl']}",
        "updn": f"{m['up4']}/{m['dn4']}",
        "d50": _pct(m["pct50"]),
        "d200": _pct(m["pct200"]),
        "rank": breadth_rank(m),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════
UNIVERSES = [
    ("NYSE", load_nyse),
    ("RSP",  load_sp500),
    ("QQQE", load_nasdaq100),
    ("IWM",  load_russell2000),
]


def main():
    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "weights": WEIGHTS,
        "universes": [],
    }
    for name, loader in UNIVERSES:
        print(f"[{name}] lade Konstituenten …")
        try:
            tickers = loader()
            print(f"[{name}] {len(tickers)} Ticker, lade Kursdaten …")
            frames = batch_download(tickers)
            m = universe_metrics(frames)
            print(f"[{name}] verarbeitet: {m['total']}/{len(tickers)} "
                  f"| A/D {m['adv']}/{m['dec']} | Rank {breadth_rank(m)}")
            out["universes"].append(build_row(name, m))
        except Exception as e:
            print(f"[{name}] FEHLER: {e}")
            out["universes"].append({
                "u": name, "ad": "—", "hl": "—", "updn": "—",
                "d50": "—", "d200": "—", "rank": 0,
            })

    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n→ geschrieben: {OUT_PATH}")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
