/* ============================================================
   GOONER LOUNGE — room + shared media logic
   Max 5 cams. Three ways to put something on the big screen:
   1) host screen share (any porn site / cock hero / spiral)
   2) host local mp3/mp4 file (streamed via captureStream)
   3) direct mp4/mp3 URL (synced player on every device)
   ============================================================ */

const ROOM_PREFIX = "lounge";
const MAX_PEERS = 5;

let p2p = null;
let chat = null;
let shareMode = null;           // 'screen' | 'file' | 'url' | null
let urlSyncGuard = false;       // prevents broadcast loops when applying remote events
let micMutedForMedia = false;   // echo prevention while sharing media with audio

// Kill the double-audio: room already hears media audio directly,
// so the sharer's mic stays muted until sharing stops.
async function enterMediaAudioMode() {
    if (!lk || !lk.room) return;
    const lp = lk.room.localParticipant;
    if (lp.isMicrophoneEnabled) {
        try {
            await lp.setMicrophoneEnabled(false);
            micMutedForMedia = true;
            lk.syncMicControls();
            chat && chat.addMessage({ name: "", text: "🎤 Mic auto-muted while media audio is playing (anti-echo). It comes back when sharing stops.", system: true });
        } catch (_) {}
    }
}

async function exitMediaAudioMode() {
    if (!micMutedForMedia || !lk || !lk.room) { micMutedForMedia = false; return; }
    try { await lk.room.localParticipant.setMicrophoneEnabled(true); lk.syncMicControls(); } catch (_) {}
    micMutedForMedia = false;
}

const tiles = new Map(); // identity -> { name, stream, muted }
let lk = null;

const $ = (id) => document.getElementById(id);
const me = () => p2p && p2p.me;
const isHost = () => p2p && p2p.isHost;

/* ============================================================
   CONNECT
   ============================================================ */

async function connect(asHost, code) {
    const name = $("nameInput").value.trim() || "Gooner " + Math.floor(Math.random() * 90 + 10);
    $("connectStatus").textContent = "Getting your cam ready…";

    p2p = new P2PRoom({ prefix: ROOM_PREFIX, maxPeers: MAX_PEERS, requireMedia: false });
    p2p.onRosterChange = updateOccupancy;
    p2p.onShareRemoved = () => {}; // superseded by lk share events
    p2p.onPeerGone = (id, who) => {
        chat && chat.addMessage({ name: "", text: `${who} left the lounge`, system: true });
        updateOccupancy();
    };
    p2p.onHostGone = () => {
        alert("The host closed the lounge.");
        location.hash = "";
        location.reload();
    };
    p2p.onHostMessage = onHostMessage;
    p2p.onAnyMessage = (peerId, msg) => {
        if (msg && msg.type === "chat") chat && chat.addMessage({ name: msg.name, text: msg.text, self: false });
    };
    p2p.onError = (err) => { $("connectStatus").textContent = "⚠️ " + err.message; };

    try {
        if (asHost) {
            const link = await p2p.host(name, (() => { const c = localStorage.getItem("batorRoom:" + ROOM_PREFIX); return c ? { code: c } : {}; })());
            $("shareLink").textContent = link;
            p2p.setRoomMeta({ title: "Gooner Lounge", password: $("passwordInput").value.trim() });
            // hub directory connects in the background so it never blocks the room
            p2p.advertiseWhenReady();
        } else {
            $("connectStatus").textContent = "Joining lounge…";
            await p2p.join(name, code, $("passwordInput").value.trim());
        }
    } catch (err) {
        $("connectStatus").textContent = "⚠️ " + (err.message || "Could not connect.");
        return;
    }

    chat = mountChatUI($("chatRoot"), {
        selfName: name,
        onSend: (text) => {
            p2p.sendAll({ type: "chat", name: me().name, text });
            chat.addMessage({ name: me().name, text, self: true });
        }
    });

    // ---- LiveKit cams & cinema (media layer) ----
    window.LK_TILE_CONFIG = {
        isHost: () => p2p && p2p.isHost,
        kick: (id) => p2p.kickPeer(id),
        selfId: () => (p2p && p2p.me && p2p.me.id) || null
    };
    lk = new LKMedia();
    lk.onTile = (id, label, stream, isLocal) => {
        tiles.set(id, { name: label, stream, muted: isLocal });
        addTile(id, label, stream, isLocal);
    };
    lk.onRemoveTile = (id) => { tiles.delete(id); removeTile(id); };
    lk.onShare = (label, stream) => showSharedStream(label, stream);
    lk.onShareEnd = () => clearCinema("Sharing ended.");
    lk.onError = (err) => { $("connectStatus").textContent = "⚠️ " + err.message; };
    await lk.connect(p2p.hostId, p2p.me.id, name);

    $("mediaBar").classList.remove("hidden");
    if (isHost()) $("mediaDeck").classList.remove("hidden");
    $("homeScreen").classList.add("hidden");
    $("loungeScreen").classList.remove("hidden");
    document.body.classList.add("lounge-active");
    $("shareLink").textContent = p2p.shareLink();
    setTiles();
    updateOccupancy();
    $("connectStatus").textContent = "";
}

function updateOccupancy() {
    if (p2p) $("occupancyCount").textContent = p2p.roster.length;
}

/* ============================================================
   CAM TILES
   ============================================================ */

function setTiles() {
    $("videoGrid").innerHTML = "";
    tiles.forEach((t, id) => addTile(id, t.name, t.stream, t.muted));
}

function addTile(peerId, label, stream, muted) {
    let tile = $("videoGrid").querySelector(`[data-peer="${peerId}"]`);
    if (!tile) {
        tile = document.createElement("div");
        tile.className = "video-tile";
        tile.dataset.peer = peerId;
        tile.innerHTML = `<video autoplay playsinline></video><span class="tile-label"></span>`;
        $("videoGrid").appendChild(tile);
    }
    const v = tile.querySelector("video");
    v.muted = muted;
    if (v.srcObject !== stream) v.srcObject = stream;
    tile.querySelector(".tile-label").textContent = label;
}

function removeTile(peerId) {
    document.querySelectorAll(`[data-peer="${peerId}"]`).forEach((t) => t.remove());
}

/* ============================================================
   CINEMA — shared screen / file stream (peers)
   ============================================================ */

function showSharedStream(label, stream) {
    shareMode = "stream";
    $("popCinemaBtn").classList.remove("hidden");
    $("cinemaPlaceholder").classList.add("hidden");
    $("cinemaHint") && ($("cinemaHint").textContent = "");
    const video = $("cinemaVideo");
    video.classList.remove("hidden");
    video.srcObject = stream;
    video.controls = false;
    video.muted = true;
    video.play().catch(() => {});
    $("cinemaUnmute").classList.remove("hidden");
    $("shareStatus").classList.remove("hidden");
    $("shareStatus").textContent = `📺 Watching: ${label}`;
    chat && chat.addMessage({ name: "", text: `📺 Host started sharing: ${label}`, system: true });
}

function clearCinema(note) {
    shareMode = null;
    $("popCinemaBtn").classList.add("hidden");
    const video = $("cinemaVideo");
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
    video.classList.add("hidden");
    $("cinemaAudio").pause();
    $("cinemaAudio").classList.add("hidden");
    $("cinemaAudio").removeAttribute("src");
    $("cinemaPlaceholder").classList.remove("hidden");
    $("cinemaHint").textContent = note || "Nothing on screen yet.";
    $("cinemaUnmute").classList.add("hidden");
    $("shareStatus").classList.add("hidden");
    $("urlPlayerBar").classList.add("hidden");
    $("shareControls").classList.add("hidden");
    $("shareSource").pause();
    $("shareSource").removeAttribute("src");
    $("shareSource").load();
}

/* ============================================================
   HOST — screen share
   ============================================================ */

async function shareScreen() {
    const ok = lk && await lk.shareScreen();
    if (!ok) {
        chat && chat.addMessage({ name: "", text: "Screen share was cancelled.", system: true });
        return;
    }
    shareMode = "screen";
    const preview = lk.localShareStream();
    if (preview) showSharedStream("your screen", preview);
    $("stopShareBtn").classList.remove("hidden");
    $("mediaDeck").open = false;
    enterMediaAudioMode();
}

/* ============================================================
   HOST — local file share (mp3/mp4 via captureStream)
   ============================================================ */

function shareFile(file) {
    const src = $("shareSource");
    src.src = URL.createObjectURL(file);
    src.loop = false;

    src.addEventListener("loadedmetadata", async () => {
        const capture = src.captureStream ? src.captureStream() : (src.mozCaptureStream ? src.mozCaptureStream() : null);
        if (!capture) {
            alert("Your browser can't stream local media files. Try Chrome.");
            return;
        }
        src.play();
        await lk.shareStream(capture, file.name);
        shareMode = "file";
        showSharedStream(file.name, capture);
        enterMediaAudioMode();
        $("stopShareBtn").classList.remove("hidden");
        $("mediaDeck").open = false;
        $("shareControls").classList.remove("hidden");
        $("shareStatus").textContent = `📺 Sharing file: ${file.name}`;
    }, { once: true });

    src.addEventListener("timeupdate", updateShareTime);
    src.addEventListener("play", () => { $("sharePlayPause").textContent = "⏸"; });
    src.addEventListener("pause", () => { $("sharePlayPause").textContent = "▶"; });
    src.addEventListener("ended", () => stopSharing("File finished."), { once: true });
}

function fmtMediaTime(t) {
    t = Math.max(0, Math.round(t || 0));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

function updateShareTime() {
    const src = $("shareSource");
    const seek = $("shareSeek");
    // don't fight the user's thumb while scrubbing
    if (!seek.matches(":active")) {
        seek.value = src.duration ? (src.currentTime / src.duration) * 100 : 0;
    }
    $("shareTime").textContent = fmtMediaTime(src.currentTime) + " / " + fmtMediaTime(src.duration);
}

function stopSharing(note) {
    if (lk) { lk.stopScreenShare(); lk.stopShareStream(); }
    exitMediaAudioMode();
    $("stopShareBtn").classList.add("hidden");
    $("mediaDeck").open = true;
    $("shareSource").pause();
    clearCinema(note || "Sharing stopped.");
    if (isHost()) p2p.hostBroadcast({ type: "media", op: "stop" });
}

/* ============================================================
   URL MEDIA — synced player on every device
   ============================================================ */

function hostLoadUrl() {
    const url = $("mediaUrlInput").value.trim();
    if (!url) return;
    if (lk) { lk.stopScreenShare(); lk.stopShareStream(); }
    enterMediaAudioMode(); // host hears their own player too — keep the room echo-free
    shareMode = "url";
    clearCinema();
    p2p.hostBroadcast({ type: "media", op: "load", src: url });
    applyMediaEvent({ op: "load", src: url });
    $("stopShareBtn").classList.remove("hidden");
    $("mediaDeck").open = false;
}

function isAudioUrl(url) {
    return /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i.test(url);
}

function mediaElement() {
    return $("cinemaAudio").classList.contains("hidden") ? $("cinemaVideo") : $("cinemaAudio");
}

function applyMediaEvent(msg) {
    urlSyncGuard = true;
    try {
        if (msg.op === "load") {
            shareMode = "url";
            $("cinemaPlaceholder").classList.add("hidden");
            const useAudio = isAudioUrl(msg.src);
            const v = $("cinemaVideo"), a = $("cinemaAudio");
            if (useAudio) {
                v.classList.add("hidden");
                a.classList.remove("hidden");
                a.src = msg.src;
                a.load();
                $("cinemaHint").textContent = "🎵 Audio is playing…";
                $("cinemaPlaceholder").classList.remove("hidden");
            } else {
                a.classList.add("hidden");
                v.classList.remove("hidden");
                v.srcObject = null;
                v.src = msg.src;
                v.controls = isHost();
                v.muted = false;
                v.load();
            }
            mediaEl = useAudio ? a : v;
            $("shareStatus").classList.remove("hidden");
            $("shareStatus").textContent = "🔗 " + msg.src.split("/").pop().slice(0, 60);
            $("urlPlayerBar").classList.remove("hidden");
            wireSync(mediaEl);
        }
        if (!mediaEl) return;
        if (msg.op === "play") {
            mediaEl.currentTime = msg.t + (Date.now() - msg.at) / 1000;
            mediaEl.play().catch(() => {});
        }
        if (msg.op === "pause") {
            mediaEl.pause();
            mediaEl.currentTime = msg.t;
        }
        if (msg.op === "seek") {
            mediaEl.currentTime = msg.t + (Date.now() - msg.at) / 1000;
        }
        if (msg.op === "stop") {
            mediaEl = null;
            clearCinema("Host cleared the screen.");
        }
    } finally {
        urlSyncGuard = false;
    }
}

let mediaEl = null;

function wireSync(el) {
    if (!isHost()) {
        el.controls = false;
        return;
    }
    el.controls = true;
    el.onplay = () => !urlSyncGuard && p2p.hostBroadcast({ type: "media", op: "play", t: el.currentTime, at: Date.now() });
    el.onpause = () => !urlSyncGuard && p2p.hostBroadcast({ type: "media", op: "pause", t: el.currentTime });
    el.onseeked = () => !urlSyncGuard && p2p.hostBroadcast({ type: "media", op: "seek", t: el.currentTime, at: Date.now() });
}

function onHostMessage(msg) {
    if (msg && msg.type === "media") applyMediaEvent(msg);
}

/* ============================================================
   EVENTS + INIT
   ============================================================ */

function init() {
    $("hostBtn").addEventListener("click", () => connect(true));
    $("joinBtn").addEventListener("click", () => {
        const code = $("joinCodeInput").value.trim().toLowerCase();
        if (code.length !== 6) { $("connectStatus").textContent = "Enter the 6-character room code."; return; }
        connect(false, code);
    });

    const m = location.hash.match(/#join=([a-z0-9]{6})/i);
    if (m) {
        $("joinCodeInput").value = m[1].toLowerCase();
        $("connectStatus").textContent = "Link loaded — enter your name and hit Join.";
        $("nameInput").focus();
    }

    $("copyLinkBtn").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("shareLink").textContent);
            $("copyLinkBtn").textContent = "Copied!";
            setTimeout(() => ($("copyLinkBtn").textContent = "Copy"), 1500);
        } catch (_) {}
    });
    $("textLinkBtn").addEventListener("click", async () => {
        const url = $("shareLink").textContent;
        if (navigator.share) {
            try { await navigator.share({ title: "Gooner Lounge", text: "Pull up — goon with us:", url }); return; } catch (_) {}
        }
        try { await navigator.clipboard.writeText(url); alert("Link copied — text it to the bros!"); } catch (_) {}
    

    // Save this room as MY permanent link (device-local)
    $("saveRoomBtn") && $("saveRoomBtn").addEventListener("click", () => {
        (() => {
                const cur = localStorage.getItem("batorRoom:" + ROOM_PREFIX) || p2p.roomCode;
                let custom = prompt("Your permanent room name (letters/numbers/dash, 3-16):", cur);
                if (custom === null) custom = cur;
                custom = custom.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
                const code = custom.length >= 3 ? custom : cur;
                localStorage.setItem("batorRoom:" + ROOM_PREFIX, code);
            })();
        $("saveRoomBtn").textContent = "🔖 Saved! This is YOUR link now";
        $("saveRoomBtn").style.borderColor = "#3dff73";
        setTimeout(() => { $("saveRoomBtn").textContent = "🔖 Permanent Link"; }, 2500);
    });});

    $("popCinemaBtn").addEventListener("click", () => {
        const v = $("cinemaVideo");
        if (v && v.srcObject instanceof MediaStream) {
            makeFloatingPiP(v.srcObject, "cinema");
        }
    });

    $("shareScreenBtn").addEventListener("click", shareScreen);
    $("shareFileInput").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) shareFile(file);
        e.target.value = "";
    });
    $("loadUrlBtn").addEventListener("click", hostLoadUrl);
    $("mediaUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") hostLoadUrl(); });
    $("stopShareBtn").addEventListener("click", () => stopSharing());

    // File playback controls (host)
    $("sharePlayPause").addEventListener("click", () => {
        const src = $("shareSource");
        src.paused ? src.play() : src.pause();
    });
    $("shareSeek").addEventListener("input", (e) => {
        const src = $("shareSource");
        if (src.duration) src.currentTime = (e.target.value / 100) * src.duration;
    });

    $("cinemaUnmute").addEventListener("click", () => {
        const v = $("cinemaVideo");
        v.muted = false;
        v.volume = $("cinemaVolume").value / 100;
        v.play().catch(() => {});
        $("cinemaUnmute").classList.add("hidden");
        $("urlPlayerBar").classList.remove("hidden");
    });
    $("cinemaVolume").addEventListener("input", (e) => {
        const el = mediaEl || $("cinemaVideo");
        el.muted = false;
        el.volume = e.target.value / 100;
    });

    $("toggleMicBtn").addEventListener("click", async () => {
        const on = lk ? await lk.toggleMic() : false;
        $("toggleMicBtn").classList.toggle("media-off", !on);
    });
    $("toggleCamBtn").addEventListener("click", async () => {
        const on = lk ? await lk.toggleCam() : false;
        $("toggleCamBtn").classList.toggle("media-off", !on);
    });

    $("leaveBtn").addEventListener("click", () => { p2p && p2p.destroy(); location.hash = ""; location.reload(); });
}

document.addEventListener("DOMContentLoaded", init);
