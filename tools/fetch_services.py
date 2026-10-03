#!/usr/bin/env python3
"""Download an SMM panel's services list into data/services.json + data/services.js.

Two sources are supported:

  1. The public services page (default):
       python3 tools/fetch_services.py --url https://smmorange.com/services

  2. The panel API (Perfect Panel style, `action=services`), more reliable:
       python3 tools/fetch_services.py --api https://smmorange.com/api/v2 --key YOUR_API_KEY

Only the Python standard library is used.
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "₽": "RUB", "₺": "TRY",
                    "₦": "NGN", "৳": "BDT", "₨": "PKR", "R$": "BRL", "₱": "PHP"}


class TableParser(HTMLParser):
    """Collects every <tr> as a list of (cell_text, data_label) tuples."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self._row = None
        self._cell = None
        self._label = None
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style"):
            self._skip += 1
        elif tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._label = a.get("data-label") or ""
        elif tag == "br" and self._cell is not None:
            self._cell.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = max(0, self._skip - 1)
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = re.sub(r"[ \t\r\f\v]+", " ", "".join(self._cell))
            text = "\n".join(l.strip() for l in text.split("\n") if l.strip())
            self._row.append((text, self._label))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(t for t, _ in self._row):
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None and not self._skip:
            self._cell.append(data)


def parse_money(text):
    s = str(text)
    currency = None
    for sym in sorted(CURRENCY_SYMBOLS, key=len, reverse=True):
        if sym in s:
            currency = CURRENCY_SYMBOLS[sym]
            break
    num = re.sub(r"[^0-9.,]", "", s)
    if "," in num and "." in num:
        num = num.replace(".", "").replace(",", ".") if num.rfind(",") > num.rfind(".") else num.replace(",", "")
    elif "," in num:
        num = num.replace(",", "") if re.search(r",\d{3}$", num) and not num.startswith("0,") else num.replace(",", ".")
    try:
        return float(num), currency
    except ValueError:
        return None, currency


def to_int(v):
    digits = re.sub(r"[^0-9]", "", str(v))
    return int(digits) if digits else None


COLUMN_KEYS = [
    ("id", re.compile(r"^(id|#)$", re.I)),
    ("rate", re.compile(r"rate|price", re.I)),
    ("min", re.compile(r"min", re.I)),
    ("max", re.compile(r"max", re.I)),
    ("time", re.compile(r"time|speed", re.I)),
    ("description", re.compile(r"desc|detail", re.I)),
    ("name", re.compile(r"service|name", re.I)),
]


def column_key(label):
    for key, rx in COLUMN_KEYS:
        if rx.search(label or ""):
            return key
    return None


def services_from_html(page):
    parser = TableParser()
    parser.feed(page)
    header = None
    category = "Uncategorised"
    out = []
    currency = None
    for row in parser.rows:
        texts = [t for t, _ in row]
        if header is None and any(re.search(r"rate|price", t, re.I) for t in texts) and len(texts) >= 4:
            header = [column_key(t) for t in texts]
            continue
        if re.fullmatch(r"\d+", texts[0] or "") and len(texts) >= 5:
            keys = [column_key(lbl) for _, lbl in row]
            if not all(keys):
                keys = header or ["id", "name", "rate", "min", "max", "time", "description"]
            rec = {}
            for k, t in zip(keys, texts):
                if k and k not in rec:
                    rec[k] = t
            rate, cur = parse_money(rec.get("rate", ""))
            currency = currency or cur
            if rate is None:
                continue
            out.append({
                "id": rec.get("id"),
                "name": rec.get("name", "").split("\n")[0],
                "category": category,
                "rate": rate,
                "min": to_int(rec.get("min", "")),
                "max": to_int(rec.get("max", "")),
                "time": rec.get("time", ""),
                "description": rec.get("description", ""),
            })
        elif len([t for t in texts if t]) == 1:
            category = next(t for t in texts if t)
    for s in out:
        s["currency"] = currency or "USD"
    return out


def services_from_api(api_url, key):
    body = urllib.parse.urlencode({"key": key, "action": "services"}).encode()
    req = urllib.request.Request(api_url, data=body, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    if isinstance(data, dict) and data.get("error"):
        raise SystemExit("API error: %s" % data["error"])
    out = []
    for s in data:
        rate, cur = parse_money(s.get("rate"))
        out.append({
            "id": str(s.get("service")),
            "name": s.get("name", ""),
            "category": s.get("category", "Uncategorised"),
            "rate": rate,
            "min": to_int(s.get("min", "")),
            "max": to_int(s.get("max", "")),
            "type": s.get("type", "Default"),
            "refill": bool(s.get("refill")),
            "cancel": bool(s.get("cancel")),
            "dripfeed": bool(s.get("dripfeed")),
            "currency": cur or "USD",
            "time": s.get("time", ""),
            "description": s.get("description", ""),
        })
    return out


def write(services, source):
    payload = {
        "source": source,
        "demo": False,
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "currency": services[0]["currency"] if services else "USD",
        "services": services,
    }
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "services.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(os.path.join(ROOT, "data", "services.js"), "w", encoding="utf-8") as f:
        f.write("// Generated by tools/fetch_services.py — do not edit by hand.\n")
        f.write("window.SERVICES_DATA = ")
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write(";\n")
    cats = len({s["category"] for s in services})
    print("Saved %d services in %d categories from %s" % (len(services), cats, source))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="https://smmorange.com/services", help="services page URL")
    ap.add_argument("--api", help="panel API URL, e.g. https://smmorange.com/api/v2")
    ap.add_argument("--key", help="panel API key (used with --api)")
    ap.add_argument("--html", help="parse a saved copy of the services page instead of downloading it")
    args = ap.parse_args()

    if args.api:
        if not args.key:
            ap.error("--api needs --key")
        services = services_from_api(args.api, args.key)
        source = args.api
    else:
        if args.html:
            with open(args.html, encoding="utf-8", errors="replace") as f:
                page = f.read()
            source = args.url
        else:
            req = urllib.request.Request(args.url, headers={"User-Agent": UA, "Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=60) as r:
                page = r.read().decode("utf-8", errors="replace")
            source = args.url
        services = services_from_html(page)
    if not services:
        sys.exit("No services found. The page may need a login or render with JavaScript — "
                 "save it from your browser and use --html, or use --api with your API key.")
    write(services, source)


if __name__ == "__main__":
    main()
