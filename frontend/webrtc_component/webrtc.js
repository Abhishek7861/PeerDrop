import { Transfer } from "./transfer.js";
const $ = (id) => document.getElementById(id);
const fmt = (n) => {
  if (!n) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][i]}`;
};
let config = {},
  file,
  ws,
  pc,
  transfer,
  role,
  heartbeat,
  statsTimer,
  connectTimer,
  disconnectTimer,
  code = "",
  started = 0,
  lastTime = 0,
  lastBytes = 0,
  peak = 0,
  pendingIce = [],
  signalQueue = Promise.resolve(),
  busy = false;
const status = (message, error = false) => {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
  resize();
};
function resize() {
  if (parent !== window)
    parent.postMessage(
      {
        isStreamlitMessage: true,
        type: "streamlit:setFrameHeight",
        height: document.documentElement.scrollHeight,
      },
      "*",
    );
}
new ResizeObserver(resize).observe(document.body);
function signal(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function close() {
  clearInterval(heartbeat);
  clearInterval(statsTimer);
  clearTimeout(connectTimer);
  clearTimeout(disconnectTimer);
  transfer?.stop();
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
}
function fail(error) {
  if (transfer?.done) return;
  status(error.message || "Connection failed. Please start again.", true);
  signal({ type: "status", status: "FAILED" });
  close();
  $("reset").hidden = false;
  $("accept").disabled = true;
  $("acceptDownload").disabled = true;
}
function tab(receive) {
  $("sendPanel").hidden = receive;
  $("receivePanel").hidden = !receive;
  $("sendTab").classList.toggle("active", !receive);
  $("receiveTab").classList.toggle("active", receive);
}
$("sendTab").onclick = () => {
  if (!busy) tab(false);
};
$("receiveTab").onclick = () => {
  if (!busy) tab(true);
};
function choose(f) {
  if (busy || !f) return;
  file = f;
  $("selected").textContent = `${f.name} · ${fmt(f.size)}`;
  $("create").disabled = false;
}
$("file").onchange = (e) => choose(e.target.files[0]);
$("drop").ondragover = (e) => {
  e.preventDefault();
  $("drop").classList.add("drag");
};
$("drop").ondragleave = () => $("drop").classList.remove("drag");
$("drop").ondrop = (e) => {
  e.preventDefault();
  $("drop").classList.remove("drag");
  choose(e.dataTransfer.files[0]);
};
function baseUrl() {
  return (
    config.public_url || `${location.protocol}//${location.hostname}:8501/`
  );
}
function wsUrl() {
  return (
    config.signaling_url ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:8765/ws`
  );
}
function setup(configValue) {
  config = configValue;
  const room = config.room || new URLSearchParams(location.search).get("room");
  if (room) {
    tab(true);
    $("codeInput").value = room;
  }
  const direct = new URL(wsUrl());
  direct.protocol = direct.protocol === "wss:" ? "https:" : "http:";
  direct.pathname = "/transfer/";
  direct.search = "";
  $("fullpage").href = direct;
}
function connect(as) {
  if (busy) return;
  if (!window.RTCPeerConnection) {
    fail(Error("This browser does not support WebRTC."));
    return;
  }
  role = as;
  busy = true;
  $("create").disabled = true;
  $("join").disabled = true;
  $("file").disabled = true;
  $("reset").hidden = false;
  status("Connecting to signaling server…");
  pendingIce = [];
  signalQueue = Promise.resolve();
  ws = new WebSocket(wsUrl());
  connectTimer = setTimeout(
    () =>
      fail(
        Error(
          "Connection timed out. Check signaling, firewall, and TURN settings.",
        ),
      ),
    60000,
  );
  ws.onopen = () => {
    clearTimeout(connectTimer);
    signal(
      role === "sender"
        ? { type: "create" }
        : { type: "join", code: $("codeInput").value.trim().toUpperCase() },
    );
    heartbeat = setInterval(() => signal({ type: "ping" }), 30000);
  };
  ws.onerror = () =>
    fail(
      Error(
        "Cannot reach signaling server. Check its address and start the server.",
      ),
    );
  ws.onclose = () => {
    if (!transfer?.done)
      fail(Error("Signaling connection closed. Start a new transfer."));
  };
  ws.onmessage = (e) => {
    signalQueue = signalQueue
      .then(() => onSignal(JSON.parse(e.data)))
      .catch(fail);
  };
}
async function onSignal(msg) {
  if (msg.type === "error") throw Error(msg.message);
  if (msg.type === "created") {
    code = msg.code;
    $("room").hidden = false;
    $("roomCode").textContent = code;
    status("Waiting for receiver…");
  } else if (msg.type === "joined") {
    status("Waiting for sender connection…");
    await peer();
  } else if (msg.type === "peer_joined") {
    status("Establishing encrypted connection…");
    await peer();
    bindChannel(pc.createDataChannel("peerdrop", { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    signal({ type: "offer", sdp: pc.localDescription.sdp });
  } else if (msg.type === "offer") {
    await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await flushIce();
    await pc.setLocalDescription(await pc.createAnswer());
    signal({ type: "answer", sdp: pc.localDescription.sdp });
  } else if (msg.type === "answer") {
    await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    await flushIce();
  } else if (msg.type === "ice") {
    if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate);
    else pendingIce.push(msg.candidate);
  } else if (msg.type === "peer_left" && !transfer?.done) {
    throw Error("The other person disconnected. Create a new room to retry.");
  }
}
async function flushIce() {
  for (const c of pendingIce) await pc.addIceCandidate(c);
  pendingIce = [];
}
async function peer() {
  pc = new RTCPeerConnection({ iceServers: config.ice_servers || [] });
  connectTimer = setTimeout(
    () =>
      fail(
        Error(
          "WebRTC could not connect. Configure TURN for restrictive networks.",
        ),
      ),
    45000,
  );
  pc.onicecandidate = (e) => {
    if (e.candidate) signal({ type: "ice", candidate: e.candidate.toJSON() });
  };
  pc.ondatachannel = (e) => bindChannel(e.channel);
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    $("connection").textContent = `Connection: ${state}`;
    if (state === "connected") {
      clearTimeout(connectTimer);
      clearTimeout(disconnectTimer);
    }
    if (state === "failed")
      fail(
        Error(
          "WebRTC connection failed. Check network connectivity or configure TURN.",
        ),
      );
    if (state === "disconnected") {
      disconnectTimer = setTimeout(
        () => fail(Error("Peer disconnected. Restart the transfer.")),
        10000,
      );
    }
  };
  statsTimer = setInterval(async () => {
    if (pc?.connectionState !== "connected") return;
    try {
      const stats = await pc.getStats();
      let pair;
      stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId)
          pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair)
        stats.forEach((s) => {
          if (
            s.type === "candidate-pair" &&
            s.nominated &&
            s.state === "succeeded"
          )
            pair = s;
        });
      if (pair) {
        const local = stats.get(pair.localCandidateId),
          remote = stats.get(pair.remoteCandidateId);
        const label = [local, remote].some((c) => c?.candidateType === "relay")
          ? "TURN Relay"
          : local?.candidateType === "host" && remote?.candidateType === "host"
            ? "Local/LAN (appears local)"
            : "Direct P2P";
        $("connection").textContent = `${label} · Connected`;
      }
    } catch {}
  }, 2000);
}
function bindChannel(channel) {
  channel.binaryType = "arraybuffer";
  channel.onerror = () =>
    fail(Error("DataChannel failed. Restart the transfer."));
  channel.onclose = () => {
    if (!transfer?.done) fail(Error("DataChannel closed before verification."));
  };
  channel.onopen = () => {
    transfer = new Transfer(
      channel,
      {
        status,
        hash: (n, size) =>
          status(
            `Calculating checksum… ${size ? Math.round((n / size) * 100) : 100}%`,
          ),
        offer: (offer) => {
          $("offer").hidden = false;
          $("fileName").textContent = offer.name;
          $("fileSize").textContent = fmt(offer.size);
          $("acceptDownload").hidden = offer.size > 64 * 1024 * 1024;
          status("Incoming file · accept only if you trust the sender.");
        },
        started: () => {
          started = lastTime = performance.now();
          lastBytes = peak = 0;
          $("transfer").hidden = false;
          $("accept").hidden = true;
          $("acceptDownload").hidden = true;
          signal({ type: "status", status: "TRANSFERRING" });
          status("Transfer in progress…");
        },
        progress: (n, total) => {
          const now = performance.now(),
            elapsed = (now - started) / 1000,
            average = n / Math.max(elapsed, 0.001);
          if (now - lastTime >= 200 || n === total) {
            const speed =
              (n - lastBytes) / Math.max((now - lastTime) / 1000, 0.001);
            peak = Math.max(peak, speed);
            $("speed").textContent = fmt(speed) + "/s";
            $("peak").textContent = fmt(peak) + "/s";
            lastTime = now;
            lastBytes = n;
          }
          $("percent").textContent =
            `${total ? ((n / total) * 100).toFixed(1) : 100}%`;
          $("progress").value = total ? (n / total) * 100 : 100;
          $("bytes").textContent = `${fmt(n)} / ${fmt(total)}`;
          $("average").textContent = fmt(average) + "/s";
          $("eta").textContent = average
            ? Math.ceil((total - n) / average) + "s"
            : "—";
          $("elapsed").textContent = `Elapsed: ${Math.floor(elapsed)}s`;
        },
        download: (url, name) => {
          $("download").href = url;
          $("download").download = name;
          $("download").hidden = false;
        },
        complete: () => {
          $("progress").value = 100;
          $("percent").textContent = "100%";
          status("✓ Transfer verified · SHA-256 matches");
          signal({ type: "status", status: "COMPLETED" });
        },
        error: fail,
      },
      pc.sctp?.maxMessageSize,
    );
    if (role === "sender") {
      $("offer").hidden = false;
      $("accept").hidden = true;
          $("acceptDownload").hidden = true;
      $("fileName").textContent = file.name;
      $("fileSize").textContent = fmt(file.size);
      transfer.prepare(file).catch(fail);
    }
  };
}
$("create").onclick = () => connect("sender");
$("join").onclick = () => {
  if (!/^[A-Z2-9]{6}$/i.test($("codeInput").value.trim())) {
    status("Enter a six-character room code.", true);
    return;
  }
  connect("receiver");
};
async function acceptFile(inMemory = false) {
  $("accept").disabled = true;
  $("acceptDownload").disabled = true;
  try {
    await transfer.accept(inMemory);
  } catch (e) {
    if (e.name === "AbortError")
      status("Save canceled. Choose a location when ready.");
    else
      status(
        e.message + " Try the full-page link below if saving is blocked.",
        true,
      );
    $("accept").disabled = false;
    $("acceptDownload").disabled = false;
  }
};
$("accept").onclick = () => acceptFile();
$("acceptDownload").onclick = () => acceptFile(true);
$("copy").onclick = async () => {
  const link = new URL(baseUrl());
  link.searchParams.set("room", code);
  try {
    await navigator.clipboard.writeText(link.href);
    status("Share link copied.");
  } catch {
    status(`Share this link: ${link.href}`);
  }
};
$("reset").onclick = () => {
  close();
  location.reload();
};
window.addEventListener("beforeunload", close);
if (parent !== window) {
  window.addEventListener("message", (e) => {
    if (e.source === parent && e.data?.type === "streamlit:render" && !busy)
      setup(e.data.args);
  });
  parent.postMessage(
    {
      isStreamlitMessage: true,
      type: "streamlit:componentReady",
      apiVersion: 1,
    },
    "*",
  );
  resize();
} else {
  fetch("/config")
    .then((r) => {
      if (!r.ok) throw Error();
      return r.json();
    })
    .then((c) =>
      setup({
        ...c,
        public_url: location.origin + "/transfer/",
        signaling_url: location.origin.replace(/^http/, "ws") + "/ws",
      }),
    )
    .catch(() => status("Could not load server configuration.", true));
}
