FBI CLIENT FILE STUDIO - NDI AUTO GATEWAY

Purpose
-------
This is the LOCAL NDI gateway for FBI Client File Studio.

IMPORTANT:
- No pairing code is required.
- No IP address needs to be entered for NDI sources.
- The gateway must run on the production PC that is connected to the same LAN/Wi-Fi as the NDI cameras, vMix, OBS, ProPresenter, or other NDI devices.
- Railway/cloud hosting cannot directly discover NDI devices on your private LAN because native NDI discovery uses local-network mDNS/multicast.

How it works
------------
1. Run run-gateway.bat on the production PC.
2. Open FBI Client File Studio on that same PC.
3. Open NDI I/O.
4. The gateway automatically discovers NDI sources on the local network.
5. Select the source and start NDI IN, or start NDI OUT.
6. No pairing screen or pairing code is involved.

Discovery
---------
The gateway uses the native NDI Finder API. NDI's standard discovery mechanism uses mDNS on the local network, so compatible NDI sources appear automatically after discovery has had a few seconds to populate.

Requirements
------------
- Windows PC
- Python 3.11+
- NDI Runtime/SDK compatible with ndi-python 6.3.2.4
- PC and NDI devices on the same LAN/subnet
- Windows network profile should normally be Private
- Firewall must allow local NDI/mDNS traffic

Local gateway address
---------------------
http://127.0.0.1:8765/status
http://127.0.0.1:8765/sources

Security
--------
The gateway binds to 127.0.0.1 by default, so it is only accessible from the production PC. Do not expose port 8765 publicly unless you deliberately configure a secure network deployment.
