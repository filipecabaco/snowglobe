#!/bin/sh
# poppler: each PDF page to a PNG, at a resolution OCR reads well
set -eu
for f in in/*.pdf; do
  pdftoppm -r 150 -png "$f" "out/$(basename "$f" .pdf)"
done
ls out
