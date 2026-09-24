# FBI Media Gateway

Dedicated RTMP ingest and HLS playback gateway for FBI Client File Studio.

## Flow

Streaming software -> RTMP :1935 -> MediaMTX -> HLS :8888 -> FBI web player

The gateway deliberately keeps media transport separate from the FBI application/API.

## Endpoints

For a stream path such as `live/ABC123`:

- RTMP publish: `rtmp://HOST:1935/live/ABC123`
- HLS manifest: `https://HOST/live/ABC123/index.m3u8`

MediaMTX generates HLS from the incoming stream. HLS uses MPEG-TS here for maximum compatibility while we validate the pipeline.

## NDI

NDI discovery remains local to the user's LAN. The local NDI gateway should discover NDI sources automatically and relay the selected source to the public RTMP ingest URL.

No NDI pairing code is required.
