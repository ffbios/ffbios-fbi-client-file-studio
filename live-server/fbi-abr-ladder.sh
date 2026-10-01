#!/bin/sh
set -u

PATHNAME="${1:-}"
KEY="${2:-}"
INPUT="rtmp://127.0.0.1:1935/${PATHNAME}"
BASE="rtmp://127.0.0.1:1935/quality"

HEIGHT=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  HEIGHT="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  case "$HEIGHT" in
    ''|*[!0-9]*) sleep 1 ;;
    *) break ;;
  esac
done
case "$HEIGHT" in ''|*[!0-9]*) HEIGHT=2160 ;; esac

max_quality=2160
if [ "$HEIGHT" -lt 2160 ]; then max_quality=1440; fi
if [ "$HEIGHT" -lt 1440 ]; then max_quality=1080; fi
if [ "$HEIGHT" -lt 1080 ]; then max_quality=720; fi
if [ "$HEIGHT" -lt 720 ]; then max_quality=480; fi
if [ "$HEIGHT" -lt 480 ]; then max_quality=360; fi
if [ "$HEIGHT" -lt 360 ]; then max_quality=240; fi

CMD="ffmpeg -hide_banner -loglevel warning -i \"$INPUT\""

append_output() {
  q="$1"; w="$2"; h="$3"; vb="$4"; mb="$5"; bb="$6"; ab="$7"
  FILTER="scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2"
  URL="${BASE}/${q}/${KEY}"
  CMD="$CMD -map 0:v:0 -vf \"$FILTER\" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v main -r 30 -g 60 -keyint_min 60 -sc_threshold 0 -b:v ${vb} -maxrate ${mb} -bufsize ${bb} -map 0:a:0? -c:a aac -b:a ${ab} -ar 48000 -ac 2 -f flv \"$URL\""
}

append_output 240 426 240 350k 450k 700k 64k
append_output 360 640 360 650k 800k 1200k 80k
if [ "$max_quality" -ge 480 ]; then append_output 480 854 480 1200k 1500k 2500k 96k; fi
if [ "$max_quality" -ge 720 ]; then append_output 720 1280 720 2500k 3000k 5000k 128k; fi
if [ "$max_quality" -ge 1080 ]; then append_output 1080 1920 1080 5000k 6000k 10000k 128k; fi
if [ "$max_quality" -ge 1440 ]; then append_output 1440 2560 1440 8500k 10000k 16000k 160k; fi
if [ "$max_quality" -ge 2160 ]; then append_output 2160 3840 2160 14000k 16000k 24000k 192k; fi

eval "$CMD"
