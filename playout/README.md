# FBI TV Playout

Keeps FBI TV on air 24/7 when the studio (OBS) isn't live. It plays the
episodes uploaded in the studio's **Episode library** at the times set in the
**Schedule**, and loops the **Filler** items between shows. OBS always takes
priority: as soon as the studio goes live, the playout steps aside.

Railway service settings:
- Root directory: `/playout`, builder: Dockerfile, watch paths: `/playout/**`
- Variables:
  - `PLAYOUT_TOKEN` — same value as on `fbi-live-standalone`
  - `WEB_BASE` — `https://live.fbigh.com`
  - `INGEST_RTMP` — `rtmp://fbi-live-ingest:1935`

Health: `GET /` returns `{ ok, onAir, playing }`.
