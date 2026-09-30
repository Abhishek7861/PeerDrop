# PeerDrop

A local-first, single-file browser-to-browser transfer app. Python/Streamlit hosts the interface; FastAPI exchanges signaling messages; a reliable, ordered WebRTC DataChannel carries files. The application server never receives file bytes. A configured TURN server can relay encrypted WebRTC traffic when a direct path is unavailable.

## Quick start (Python 3.12+)

```sh
git clone https://github.com/Abhishek7861/PeerDrop.git
cd PeerDrop
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python signaling/server.py
```

In another terminal:

```sh
cd PeerDrop
source .venv/bin/activate
streamlit run app.py
```

Open http://localhost:8501. The standalone component is also available at http://localhost:8765/transfer/ and supports the same protocol. No frontend build or external CDN is required.

## Deploy with Streamlit Community Cloud

Deploying `app.py` starts the interface only. Cloud does not run `signaling/server.py` for you. Never point the cloud app at its own port 8765; deploy the signaling service first.

1. Open [Deploy the signaling service on Render](https://render.com/deploy?repo=https://github.com/Abhishek7861/PeerDrop). Sign in and review the included `render.yaml` Blueprint. It requests one free Python web service, with no database or disk. Free-service availability is subject to Render's account limits.
2. Set the prompted `ALLOWED_ORIGINS` value to `https://7zqbe2t2hlycslhhmnmuty.streamlit.app` (no path). For another app, use its actual HTTPS origin. Multiple origins can be comma separated. The Render service's own HTTPS origin is added automatically for its standalone transfer page.
3. After the service is live, open its `/health` URL; it should return `{"status":"ok"}`. Copy the actual assigned hostname; do not assume the service name determines the URL.
4. In Streamlit Cloud, open your app's **Settings → Secrets** and add:

```toml
SIGNALING_URL = "wss://YOUR-ACTUAL-SIGNALING-HOST.onrender.com/ws"
PUBLIC_APP_URL = "https://7zqbe2t2hlycslhhmnmuty.streamlit.app/"
```

5. Save and reboot the Streamlit app if needed. Reload both browser tabs, create a fresh room, and test a small file first.

Streamlit reads these root-level secrets explicitly; environment variables take precedence. Both HTTPS and secure WebSockets are required. Render supplies the `PORT` environment variable, which the server now honors. Keep the service at one instance/worker because rooms are in memory.

Free hosting can sleep or restart: the first connection may take time, and existing rooms are lost on restart. Reload and retry after the health endpoint responds. TURN is still needed for some networks; STUN alone cannot guarantee every pair of devices can connect. Configure TURN on both deployments if required. If a native save picker is unavailable inside the iframe, use the bounded download option for small files or open the standalone `/transfer/` page on the signaling service for large files.

## Architecture and files

```text
Sender browser ── WebSocket signaling ── FastAPI ── WebSocket signaling ── Receiver browser
       └════════════ encrypted WebRTC DataChannel file stream ═══════════════┘
```

- `app.py`: Streamlit shell and custom component configuration. Does not use `st.file_uploader`.
- `signaling/server.py`: bounded JSON signaling, origin checks, presence, expiration, static standalone view.
- `signaling/rooms.py`: cryptographically random six-character codes and ephemeral room state.
- `services/transfer_service.py`: STUN/TURN configuration.
- `frontend/webrtc_component/webrtc.js`: UI, WebSocket signaling, SDP/ICE, connection metrics.
- `frontend/webrtc_component/transfer.js`: chunk framing, flow control, saving, integrity protocol.
- `frontend/webrtc_component/hash.js`: incremental SHA-256 without whole-file buffering.
- `models/transfer.py`: Python metadata reference model.
- `utils/`: reference local hashing and byte formatting.
- `tests/`: protocol, hashing, backpressure, and signaling tests.

## Signaling and room lifecycle

The sender opens `/ws` and requests `create`. A room contains its code, sender, receiver, creation/expiry timestamps, and status. Waiting rooms expire after 15 minutes. One receiver can join. The server prompts the sender to create an SDP offer, forwards the receiver's answer, and forwards trickled ICE candidates. Candidates arriving before the remote SDP are queued in the browser. File metadata and checksums travel through the DataChannel, not signaling.

States are WAITING, CONNECTING, TRANSFERRING, COMPLETED, FAILED, and EXPIRED. Disconnects remove rooms immediately; this version does not resume interrupted transfers. Ping messages keep idle sockets alive. The registry is process-local: run **one signaling worker**. Restarting the server ends rooms. At most 1,000 rooms are allowed. Each socket is limited to 300 messages per ten seconds and 64 KiB per signaling message. Origin checks default to local app addresses.

## File protocol and integrity

The sender reads the selected browser File in 256 KiB slices to calculate SHA-256, then sends `FILE_OFFER` containing `file_id`, `name`, `size`, `mime_type`, `chunk_size`, and `sha256`. This pre-pass takes time for large files but uses bounded memory. The receiver chooses a destination and returns `FILE_ACCEPT` before bytes flow.

Each binary message has a 32-byte big-endian header: 16-byte random file ID, uint32 chunk number, uint64 byte offset, uint32 payload length. The receiver validates identifiers, lengths, order, offsets, and offered total size. The sender defaults to 256 KiB payloads and clamps the payload to the negotiated SCTP maximum minus the header (64 KiB conservative message fallback).

After all chunks, the sender emits `FILE_COMPLETE`. The receiver compares its incremental SHA-256 with the offer, commits the writable file only on success, and returns `FILE_VERIFIED`. The sender displays success only after this acknowledgment. SHA-256 detects corruption; room codes do not authenticate the other person's identity.

## Backpressure and large files

`bufferedAmountLowThreshold` is 256 KiB. When `bufferedAmount` exceeds 1 MiB, sending waits for `bufferedamountlow` with close and timeout handling. In addition, every chunk must be acknowledged **after the receiver finishes its disk write**. This keeps both browser queues bounded even when storage is slow. The conservative one-chunk acknowledgment window favors bounded memory and correctness; it can limit throughput on high-latency paths. Future versions could use a bounded sliding window.

Chrome/Edge's File System Access API streams bytes to a user-selected destination, supporting files beyond 10 GB without accumulating them in JavaScript memory. Actual capacity depends on disk space and browser/OS support. Full-file hashing requires two sender read passes. No 10 GB benchmark is claimed.

The “Accept & download after transfer” option uses a Blob download only for files **up to 64 MiB**, and also works when an embedded save picker is unavailable. Browsers without the save API automatically use this bounded fallback. Larger files are rejected before acceptance. Blob data is released on reset. On cancellation or failure, writable streams are aborted instead of committed. The browser/OS may temporarily stage writes locally. The application server never stores transferred data.

## Two-window test

1. Open two windows at http://localhost:8501 (or `/transfer/`).
2. Sender: select a file, create a transfer link, and copy the code/link.
3. Receiver: choose Receive, enter the code, and connect.
4. Wait for checksum calculation; accept and choose a save location.
5. Both sides should show progress and then **Transfer verified · SHA-256 matches**.
6. Compare the saved file with the original, e.g. `shasum -a 256 /path/to/original /path/to/received`.
7. Test a zero-byte file, cancellation, a wrong code, a second receiver, and closing a tab during transfer.

Save pickers need a user gesture and a secure context. If the Streamlit iframe blocks the picker, open the full-page transfer view **on both sides**, create a fresh room, and retry. Keeping both endpoints on the full-page view avoids iframe permissions restrictions. Some browsers allow smaller transfers on plain LAN HTTP; do not rely on this for large files.

## Two devices on the same Wi-Fi

For a quick small-file trial, run both servers on the sender machine, allow inbound TCP ports 8765 and 8501 in its firewall, and open `http://HOST_LAN_IP:8501` from both devices. Set the origin allowlist before starting signaling:

```sh
export ALLOWED_ORIGINS='http://HOST_LAN_IP:8501,http://HOST_LAN_IP:8765'
python signaling/server.py
```

In the Streamlit terminal:

```sh
export SIGNALING_URL='ws://HOST_LAN_IP:8765/ws'
export PUBLIC_APP_URL='http://HOST_LAN_IP:8501/'
streamlit run app.py --server.address 0.0.0.0
```

Replace HOST_LAN_IP with the actual host address. For large-file saving across devices, use a trusted HTTPS reverse proxy (for example, Caddy with a certificate trusted by both devices). Proxy `/ws`, `/config`, and `/transfer/*` to port 8765, and Streamlit including its WebSockets to port 8501. Set `SIGNALING_URL=wss://YOUR_HOST/ws`, `PUBLIC_APP_URL=https://YOUR_HOST/`, and `ALLOWED_ORIGINS=https://YOUR_HOST`. HTTPS pages must use WSS. Client isolation on guest Wi-Fi can prevent direct peer connectivity.

## STUN and TURN

Default STUN: `stun:stun.l.google.com:19302`. Configure the following environment variables in **both server terminals**:

```sh
export STUN_URL='stun:stun.l.google.com:19302'
export TURN_URL='turn:YOUR_TURN_HOST:3478'
export TURN_USERNAME='YOUR_USERNAME'
export TURN_PASSWORD='YOUR_PASSWORD'
```

`turns:YOUR_TURN_HOST:5349` can be used for TLS. Use your own reachable TURN service with appropriate UDP/TCP firewall ports. Browser clients necessarily receive TURN credentials; use short-lived credentials for a public deployment and never commit passwords. No cloud upload fallback is provided. TURN relays encrypted packets and is identified as **TURN Relay** in the UI. Host-to-host ICE candidates are shown as **Local/LAN (appears local)**; candidate types cannot prove physical network proximity.

## Tests

```sh
python -m pytest -q
node --test tests/*.test.js
```

Optional Chromium end-to-end test (requires both servers running):

```sh
pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

Tests exercise incremental SHA-256 against Node's crypto implementation, framing above 4 GiB, zero-byte and chunked transfer, checksum failure, buffer flow control, room expiry, duplicate receivers, binary rejection, SDP/ICE forwarding, and disconnect cleanup. Browser smoke tests verify a real local WebRTC transfer and Streamlit component loading.

## Scope and security

Share room codes privately. Possession of a code grants access; there is no authentication, recovery, resume, file execution, cloud storage, folder transfer, compression, payment, or account system. File names are displayed with `textContent` and downloads use binary MIME type. Keep tabs open and devices awake during transfer. A public deployment needs deployment-specific abuse controls, TLS, and TURN credential issuance. Existing room limits and per-socket limits are designed for local V1 usage, not unrestricted internet-scale hosting.

## Verification on this machine

19 automated tests passed (15 JavaScript, 4 Python). A real 2 MiB WebRTC transfer from the Streamlit component to the standalone receiver completed with matching SHA-256 checksums on both ends. UI rendering and room creation were checked in the browser. Native disk-saving and files over 10 GB were not exercised here. The standalone Playwright launcher was blocked by the macOS sandbox; the real transfer was instead verified using the available browser. Port 8765 avoids an existing local service on port 8000.

## GitHub repository and hosting

This is a public GitHub source repository. GitHub Actions runs the Python and JavaScript tests on pushes to main and on pull requests. GitHub Pages cannot run the Python Streamlit or FastAPI servers. To make the app publicly accessible, deploy both services behind HTTPS/WSS and configure their public addresses and allowed origins as described above.
