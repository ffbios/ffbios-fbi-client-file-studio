# FBI Live Recorder service

The Railway service **FBI Live Recorder** runs the same `server.js` with
`RECORDER_ROLE=only`. It records live broadcasts, turns them into fast-start
replays with thumbnails, and joins pieces of a broadcast.

The web services (`fbi-client-file-studio`, `fbi-live-standalone`) run with
`RECORDER_ROLE=off`, so deploying the website never interrupts a recording.

The recorder only redeploys when a file in this folder changes (Railway watch
pattern `/live-recorder/**`). To ship recorder changes made in `server.js`,
make sure nobody is live, then bump the version below and push.

recorder-version: 1
