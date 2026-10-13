# FBI TV Playout

Keeps FBI TV on air 24/7 when the studio (OBS) isn't live. It plays the
episodes uploaded in the studio's **Episode library** at the times set in the
**Schedule**, and loops the **Filler** items between shows. OBS always takes
priority: as soon as the studio goes live, the playout steps aside.

Promos: each show in the Schedule can play a promo **before** and/or **after**
every episode — its own promo, another show's, or "the next show's promo"
(coming up). Promo clips are uploaded in the Episode library under
"<Show> — promos" (stored as series `Promo: <Show>`) and rotate in order.
Promos count towards the slot's length, and only whole episodes are planned:
if the next episode won't fit, the rest of the slot plays Filler.

Railway service settings:
- Root directory: `/playout`, builder: Dockerfile, watch paths: `/playout/**`
- Variables:
  - `PLAYOUT_TOKEN` — same value as on `fbi-live-standalone`
  - `WEB_BASE` — `https://live.fbigh.com`
  - `INGEST_RTMP` — `rtmp://fbi-live-ingest:1935`

Episodes are played at 1080p (6 Mbps); the ingest makes the 720p, 480p and 360p copies.

Health: `GET /` returns `{ ok, onAir, playing }`.
