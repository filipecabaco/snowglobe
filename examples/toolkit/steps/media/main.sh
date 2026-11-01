#!/bin/sh
# ffmpeg + vips: a clip, and a contact sheet of its frames
set -eu
ffmpeg -v error -f lavfi -i "testsrc2=duration=2:size=480x270:rate=10" -c:v mpeg4 -q:v 5 out/clip.mp4
ffmpeg -v error -i out/clip.mp4 -vf "fps=2" frame-%02d.png
vips arrayjoin "$(ls frame-*.png | tr '\n' ' ')" out/contact-sheet.png --across 2
ls -l out
vipsheader out/contact-sheet.png
