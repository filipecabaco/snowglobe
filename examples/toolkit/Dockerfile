# A toolkit machine: command-line tools instead of a language, in the shape of Exclave's
# toolkits (poppler, tesseract, vips, qpdf, jq, sqlite, ffmpeg, python), all in one snapshot.
# Built --sandbox and bundled, it runs jobs with no Docker, KVM or Firecracker:
#
#   snowglobe build examples/toolkit --sandbox --out dist/toolkit
#   snowglobe bundle dist/toolkit -o toolkit
#   ./toolkit --workspace DIR --cmd 'sh main.sh'     # DIR/in -> the guest, out/ -> DIR/out
#
# examples/toolkit/workflow.exs chains jobs into a workflow (a step's out/ is the next one's in/)
FROM alpine:3.24.2

RUN apk add --no-cache \
      poppler-utils qpdf \
      tesseract-ocr tesseract-ocr-data-eng \
      vips-tools vips-poppler font-dejavu \
      py3-img2pdf python3 \
      jq sqlite \
      ffmpeg

ENV LANG=C.UTF-8 PS1='toolkit $ ' OMP_THREAD_LIMIT=1
WORKDIR /root
CMD ["/bin/sh"]

LABEL snowglobe.title="Toolkits: poppler, tesseract, vips, ffmpeg, sqlite" \
      snowglobe.ready="toolkit $ " \
      snowglobe.memory="768"
