FROM jrottenberg/ffmpeg:8-ubuntu AS ffmpeg

FROM bluenviron/mediamtx:1
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY live-server/mediamtx.yml /mediamtx.yml
CMD ["/mediamtx","/mediamtx.yml"]
