#!/bin/sh
# python: the fields of each invoice, from its OCR text
exec python3 - <<'PY'
import json, os, re, glob
rows = []
for path in sorted(glob.glob("in/*.txt")):
    text = open(path).read()
    find = lambda pattern: (re.search(pattern, text, re.I) or [None, None])[1]
    total = find(r"TOTAL:?\s*([\d.,]+)")
    rows.append({
        "file": os.path.basename(path),
        "invoice": find(r"INVOICE\s*#?\s*(\d+)"),
        "vendor": (find(r"Vendor:?\s*(.+)") or "").strip(),
        "total": float(total.replace(",", "")) if total else None,
    })
json.dump(rows, open("out/invoices.json", "w"), indent=2)
print(json.dumps(rows, indent=2))
PY
