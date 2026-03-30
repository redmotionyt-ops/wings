VPS-ready node package for in-01.fluxplus.in

What changed:
- nodes.json now points to https://in-01.fluxplus.in
- server.js now builds node URLs correctly for HTTPS/443
- daemon binds to 127.0.0.1 by default and is meant to sit behind Nginx
- trust proxy + secure cookie support added

Typical layout:
- panel/backend on core.fluxplus.in
- daemon on in-01.fluxplus.in via Nginx -> 127.0.0.1:8443
