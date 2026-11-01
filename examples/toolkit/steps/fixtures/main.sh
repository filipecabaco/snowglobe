#!/bin/sh
# vips + img2pdf: three scanned invoices, as image-only PDFs (no text layer: OCR is the only way in)
set -eu
mkdir -p out
i=0
for vendor in "Acme Tools" "Globex Ltd" "Acme Tools"; do
  i=$((i + 1))
  total=$(( (i * 7919) % 2000 + 100 ))
  # vips text renders a mask (white on black): inverted, with a margin, it is a page
  vips text t.png "INVOICE #10$i
Vendor: $vendor
Date: 2026-10-0$i

2 x Widget  ....  $((total / 4)).00
1 x Service ....  $((total - 2 * (total / 4))).00

TOTAL: $total.00 EUR" --dpi 150 --font "DejaVu Sans Mono 11"
  vips invert t.png i.png
  w=$(vipsheader -f width i.png) h=$(vipsheader -f height i.png)
  vips embed i.png p.png 60 60 $((w + 120)) $((h + 120)) --extend white
  img2pdf --imgsize 150dpi p.png -o "out/invoice-10$i.pdf"
done
ls -l out
