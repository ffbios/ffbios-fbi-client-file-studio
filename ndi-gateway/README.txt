FBI NDI Gateway

Local companion for the NDI I/O tab in FBI Client File Studio.

Functions:
- Discover NDI sources on the local production network.
- NDI IN: receive a selected NDI source and publish it to an FBI Live channel.
- NDI OUT: receive an FBI Live HLS channel and publish it as a native NDI source locally.
- Local control API on 127.0.0.1:8765.
- Optional cloud pairing heartbeat.

Requirements:
1. Current NDI SDK/runtime from NDI.
2. Python 3.10-3.14.
3. pip install -r requirements.txt
4. A production LAN where the NDI devices are reachable.

The current NDI Software SDK supports software integrations for receiving NDI sources and sending NDI High Bandwidth video. NDI SDK is available for Windows, macOS and Linux. See the official SDK page linked below.

SDK: https://ndi.video/for-developers/ndi-sdk/download/

Run: run-gateway.bat
