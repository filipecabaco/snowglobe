#!/bin/sh
# tesseract: the text of each page image
set -eu
for f in in/*.png; do
  tesseract "$f" "out/$(basename "$f" .png)" --psm 6 2>/dev/null
done
head -n 3 out/*.txt
