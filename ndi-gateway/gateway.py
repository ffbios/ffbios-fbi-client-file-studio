#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlparse
import numpy as np

try:
    import av
except Exception:
    av = None
try:
    import NDIlib as ndi
except Exception:
    ndi = None

HOST = "127.0.0.1"
PORT = 8765
VERSION = "0.2.0"
STOP = threading.Event()
LOCK = threading.Lock()
INPUT_THREAD = None
OUTPUT_THREAD = None
STATE = {
    "connected": ndi is not None,
    "version": VERSION,
    "sources": 0,
    "source_names": [],
    "discovery": "mDNS / NDI Public Group",
    "input": {"running": False, "message": "Stopped"},
    "output": {"running": False, "message": "Stopped"},
}

def reply(h, payload, code=200):
    raw = json.dumps(payload).encode()
    h.send_response(code)
    h.send_header("Content-Type", "application/json")
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")
    h.send_header("Content-Length", str(len(raw)))
    h.end_headers()
    h.wfile.write(raw)

def discover():
    if ndi is None or not ndi.initialize():
        return []
    finder = None
    try:
        finder = ndi.find_create_v2()
        if finder is None:
            return []
        ndi.find_wait_for_sources(finder, 1200)
        return [str(x.ndi_name) for x in ndi.find_get_current_sources(finder)]
    except Exception:
        return []
    finally:
        try:
            if finder is not None:
                ndi.find_destroy(finder)
            ndi.destroy()
        except Exception:
            pass

def source_loop():
    while not STOP.is_set():
        names = discover()
        with LOCK:
            STATE["source_names"] = names
            STATE["sources"] = len(names)
        STOP.wait(3)

def heartbeat_loop(studio, pair):
    while not STOP.is_set():
        try:
            body = json.dumps({
                "status": "connected",
                "active_input": STATE["input"]["message"],
                "active_output": STATE["output"]["message"],
            }).encode()
            req = Request(
                studio.rstrip("/") + "/api/ndi/gateway/" + pair + "/heartbeat",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=6):
                pass
        except Exception:
            pass
        STOP.wait(10)

def set_state(which, running, message):
    with LOCK:
        STATE[which] = {"running": running, "message": message}

def ndi_to_rtmp(source_name, rtmp_url):
    if ndi is None:
        raise RuntimeError("NDI SDK/runtime is not installed")
    if av is None:
        raise RuntimeError("PyAV is not installed")
    if not ndi.initialize():
        raise RuntimeError("NDI initialization failed")

    finder = ndi.find_create_v2()
    if finder is None:
        raise RuntimeError("NDI source finder failed")
    recv = None
    out = None
    try:
        ndi.find_wait_for_sources(finder, 1000)
        sources = ndi.find_get_current_sources(finder)
        source = next((x for x in sources if str(x.ndi_name) == source_name), None)
        if source is None:
            raise RuntimeError("NDI source not found: " + source_name)

        rc = ndi.RecvCreateV3()
        rc.color_format = ndi.RECV_COLOR_FORMAT_BGRX_BGRA
        rc.bandwidth = ndi.RECV_BANDWIDTH_HIGHEST
        recv = ndi.recv_create_v3(rc)
        if recv is None:
            raise RuntimeError("Could not create NDI receiver")
        ndi.recv_connect(recv, source)
        out = av.open(rtmp_url, mode="w", format="flv")
        vstream = None
        astream = None

        while not STOP.is_set():
            typ, vf, af, _ = ndi.recv_capture_v2(recv, 250, want_video=True, want_audio=True, want_metadata=False)
            if typ == ndi.FRAME_TYPE_NONE:
                continue

            if typ == ndi.FRAME_TYPE_VIDEO and vf is not None:
                arr = np.ascontiguousarray(vf.data)
                if arr.ndim != 3 or arr.shape[-1] < 4:
                    ndi.recv_free_video_v2(recv, vf)
                    continue
                frame = av.VideoFrame.from_ndarray(arr[:, :, :4], format="bgra")
                if vstream is None:
                    rate = (vf.frame_rate_N, vf.frame_rate_D) if vf.frame_rate_N else 30
                    vstream = out.add_stream("libx264", rate=rate)
                    vstream.width = vf.xres
                    vstream.height = vf.yres
                    vstream.pix_fmt = "yuv420p"
                    vstream.options = {"preset": "veryfast", "tune": "zerolatency"}
                    vstream.bit_rate = 6000000
                for pkt in vstream.encode(frame):
                    out.mux(pkt)
                ndi.recv_free_video_v2(recv, vf)

            elif typ == ndi.FRAME_TYPE_AUDIO and af is not None:
                arr = np.ascontiguousarray(af.data)
                if arr.size:
                    channels = int(af.no_channels or 2)
                    layout = "mono" if channels == 1 else "stereo"
                    if astream is None:
                        astream = out.add_stream("aac", rate=af.sample_rate)
                        astream.layout = layout
                        astream.bit_rate = 192000
                    frame = av.AudioFrame.from_ndarray(arr, format="fltp", layout=layout)
                    frame.sample_rate = af.sample_rate
                    for pkt in astream.encode(frame):
                        out.mux(pkt)
                ndi.recv_free_audio_v2(recv, af)

        if vstream:
            for pkt in vstream.encode(None):
                out.mux(pkt)
        if astream:
            for pkt in astream.encode(None):
                out.mux(pkt)
    finally:
        try:
            if out:
                out.close()
            if recv:
                ndi.recv_destroy(recv)
            ndi.find_destroy(finder)
            ndi.destroy()
        except Exception:
            pass

def media_to_ndi(source_url, ndi_name):
    if ndi is None:
        raise RuntimeError("NDI SDK/runtime is not installed")
    if av is None:
        raise RuntimeError("PyAV is not installed")
    if not (source_url.startswith("rtmp://") or source_url.startswith("rtmps://") or source_url.endswith(".m3u8")):
        source_url = source_url.rstrip("/") + "/index.m3u8"
    if not ndi.initialize():
        raise RuntimeError("NDI initialization failed")

    settings = ndi.SendCreate()
    settings.ndi_name = ndi_name
    settings.groups = "Public"
    settings.clock_video = False
    settings.clock_audio = False
    sender = ndi.send_create(settings)
    if sender is None:
        raise RuntimeError("Could not create NDI sender")

    container = None
    try:
        container = av.open(source_url, mode="r")
        for frame in container.decode():
            if STOP.is_set():
                break
            if isinstance(frame, av.VideoFrame):
                arr = np.ascontiguousarray(frame.to_ndarray(format="bgra"))
                vf = ndi.VideoFrameV2()
                vf.data = arr
                vf.FourCC = ndi.FOURCC_VIDEO_TYPE_BGRX
                if frame.time_base and frame.rate:
                    vf.frame_rate_N = int(frame.rate.numerator)
                    vf.frame_rate_D = int(frame.rate.denominator)
                ndi.send_send_video_v2(sender, vf)
            elif isinstance(frame, av.AudioFrame):
                arr = np.ascontiguousarray(frame.to_ndarray(format="fltp"))
                af = ndi.AudioFrameV2()
                af.data = arr
                af.sample_rate = frame.sample_rate
                af.no_channels = frame.layout.channels
                ndi.send_send_audio_v2(sender, af)
    finally:
        try:
            if container:
                container.close()
            ndi.send_destroy(sender)
            ndi.destroy()
        except Exception:
            pass

def start_input(payload):
    global INPUT_THREAD
    if INPUT_THREAD and INPUT_THREAD.is_alive():
        raise RuntimeError("NDI IN is already running")
    src = str(payload.get("source_name", "")).strip()
    server = str(payload.get("rtmp_server", "")).strip().rstrip("/")
    key = str(payload.get("stream_key", "")).strip()
    if not src or not server or not key:
        raise RuntimeError("NDI source and FBI Live channel are required")
    STOP.clear()
    def run():
        set_state("input", True, "Receiving " + src + " to FBI Live")
        try:
            ndi_to_rtmp(src, server + "/" + key)
            set_state("input", False, "Stopped")
        except Exception as exc:
            set_state("input", False, "Error: " + str(exc))
            traceback.print_exc()
    INPUT_THREAD = threading.Thread(target=run, daemon=True)
    INPUT_THREAD.start()

def start_output(payload):
    global OUTPUT_THREAD
    if OUTPUT_THREAD and OUTPUT_THREAD.is_alive():
        raise RuntimeError("NDI OUT is already running")
    hls = str(payload.get("hls_url", "")).strip()
    name = str(payload.get("ndi_name", "FBI Live OUT")).strip() or "FBI Live OUT"
    if not hls:
        raise RuntimeError("FBI Live stream URL is required")
    STOP.clear()
    def run():
        set_state("output", True, "Sending FBI Live as " + name)
        try:
            media_to_ndi(hls, name)
            set_state("output", False, "Stopped")
        except Exception as exc:
            set_state("output", False, "Error: " + str(exc))
            traceback.print_exc()
    OUTPUT_THREAD = threading.Thread(target=run, daemon=True)
    OUTPUT_THREAD.start()

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        reply(self, {"ok": True})
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/status":
            with LOCK:
                reply(self, dict(STATE))
            return
        if path == "/sources":
            with LOCK:
                reply(self, {"sources": list(STATE["source_names"])})
            return
        reply(self, {"error": "Not found"}, 404)
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode() if length else "{}")
        except Exception:
            payload = {}
        try:
            if path == "/input/start":
                start_input(payload)
                return reply(self, {"ok": True})
            if path == "/input/stop":
                STOP.set()
                set_state("input", False, "Stopped")
                return reply(self, {"ok": True})
            if path == "/output/start":
                start_output(payload)
                return reply(self, {"ok": True})
            if path == "/output/stop":
                STOP.set()
                set_state("output", False, "Stopped")
                return reply(self, {"ok": True})
        except Exception as exc:
            return reply(self, {"error": str(exc)}, 400)
        reply(self, {"error": "Not found"}, 404)
    def log_message(self, *_):
        pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--studio", default="", help="Legacy optional Studio heartbeat URL")
    parser.add_argument("--pair", default="", help="Legacy optional pairing token; not required for local NDI discovery")
    parser.add_argument("--host", default=HOST, help="Local bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    threading.Thread(target=source_loop, daemon=True).start()
    if args.studio and args.pair:
        threading.Thread(target=heartbeat_loop, args=(args.studio, args.pair), daemon=True).start()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("FBI NDI Gateway " + VERSION + " listening at http://" + args.host + ":" + str(args.port))
    print("NDI sources are discovered on the local production network.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        STOP.set()
        server.server_close()

if __name__ == "__main__":
    main()
