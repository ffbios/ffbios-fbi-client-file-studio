FROM bluenviron/mediamtx:1.19.2-ffmpeg

COPY mediamtx.yml /mediamtx.yml
COPY fbi-abr-ladder.sh /usr/local/bin/fbi-abr-ladder
COPY fbi-live-encode.sh /usr/local/bin/fbi-live-encode
RUN chmod +x /usr/local/bin/fbi-abr-ladder /usr/local/bin/fbi-live-encode

CMD ["/mediamtx.yml"]
