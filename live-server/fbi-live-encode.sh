#!/bin/sh
set -u

PATHNAME="${1:-}"
KEY="${2:-}"
INPUT="rtmp://127.0.0.1:1935/${PATHNAME}"

# Additive quality ladder. The existing browser-safe encoded stream below
# remains the primary fallback and is unchanged in codec/profile behavior.
/usr/local/bin/fbi-abr-ladder "$PATHNAME" "$KEY" &
ABR_PID=$!

cleanup() {
  kill "$ABR_PID" 2>/dev/null || true
  wait "$ABR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ffmpeg -hide_banner -loglevel warning \
  -i "$INPUT" \
  -map 0:v:0 \
  -map 0:a:0? \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p -profile:v main -level 4.1 \
  -r 30 -g 60 -keyint_min 60 -sc_threshold 0 \
  -b:v 5M -maxrate 6M -bufsize 10M \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f flv "rtmp://127.0.0.1:1935/encoded/${KEY}"
exit $?
