/* ============================================================
   p2p.js — Bator Games shared P2P layer
   WebRTC video + data mesh via PeerJS (free cloud broker).
   No account, no server of your own. Streams go browser-to-browser.

   Optional: for connections behind strict NATs, add free TURN
   credentials (e.g. metered.ca free tier) to ICE_SERVERS below.
   ============================================================ */

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
    // { urls: "turn:YOUR_TURN_HOST", username: "...", credential: "..." }
];

class P2PRoom {
    constructor({ prefix = "bg", maxVideoTiles = 6, maxPeers = Infinity, requireMedia = true } = {}) {
        this.prefix = prefix;
        this.maxVideoTiles = maxVideoTiles;
        this.maxPeers = maxPeers;
        this.mediaEnabled = requireMedia;

        this.peer = null;
        this.me = null;            // { id, name }
        this.isHost = false;
        this.hostId = null;
        this.roomCode = null;
        this.roster = [];          // [{ id, name }] (host-authoritative)
        this.localStream = null;

        this.conns = new Map();    // peerId -> DataConnection
        this.calls = new Map();    // peerId -> MediaConnection

        // ---- host media-share (screen share / local file stream) ----
        this.shareStream = null;
        this.shareLabel = null;
        this.shareCalls = new Map(); // peerId -> MediaConnection

        // Camera/mic denial handling (joiners without cam still join)
        this.mediaDenied = false;
        this._deniedNoticeEl = null;

        // Room metadata (hub directory + optional password)
        this.roomMeta = { title: "", password: "", listed: true };

        // Presence/directory probes (data-only connections, don't join roster)
        this._probes = new Set();

        // ---- callbacks (set by the game) ----
        this.onRosterChange = () => {};
        this.onHostMessage = () => {};      // peers: messages FROM host
        this.onPeerMessage = () => {};      // host: messages FROM a peer
        this.onAnyMessage = () => {};       // everyone: chat etc.
        this.onStream = () => {};           // (peerId, name, MediaStream)
        this.onStreamRemoved = () => {};    // (peerId)
        this.onShareStream = () => {};      // (label, MediaStream) — peers: host started sharing
        this.onShareRemoved = () => {};     // share ended
        this.onLocalStreamReady = () => {}; // (MediaStream) — fired when media arrives (initial deny + later allow)
        this.onPeerGone = () => {};         // (peerId, name)
        this.onHostGone = () => {};
        this.onError = () => {};
    }

    /* ---------- public API ---------- */

    /**
     * Host a room. options.code pins a specific room code (hub presence).
     */
    async host(name, options = {}) {
        if (options.requireMedia === false) this.mediaEnabled = false;
        if (this.mediaEnabled) await this._getMedia();
        this.isHost = true;
        this.roomCode = (options.code || this._randomCode()).toLowerCase();
        this.hostId = `${this.prefix}-${this.roomCode}`;
        this.peer = new Peer(this.hostId, { config: { iceServers: ICE_SERVERS } });
        await this._waitOpen();
        this.me = { id: this.hostId, name };
        this.roster = [this.me];
        this._wireCommon();
        return this.shareLink();
    }

    /** Set room title/password. Empty password = public + listed on hub. */
    setRoomMeta({ title = "", password = "", listed } = {}) {
        this.roomMeta = {
            title,
            password,
            listed: listed !== undefined ? !!listed : !password
        };
    }

    async join(name, code, password = "", options = {}) {
        if (options.requireMedia === false) this.mediaEnabled = false;
        if (this.mediaEnabled) await this._getMedia();
        this.isHost = false;
        this.roomCode = code.toLowerCase();
        this.hostId = `${this.prefix}-${this.roomCode}`;
        this.password = password;
        this.peer = new Peer({ config: { iceServers: ICE_SERVERS } });
        await this._waitOpen();
        this.me = { id: this.peer.id, name };
        this._wireCommon();

        // Connect to host; roster comes back and we mesh from there
        this._ensureData(this.hostId);
        if (this.mediaEnabled) this._ensureCall(this.hostId); // cam to host first
        return null;
    }

    shareLink() {
        return `${location.origin}${location.pathname}#join=${this.roomCode}`;
    }

    /** Everyone: fire-and-forget to all peers (chat, etc. — broadcast by host for consistency) */
    sendAll(payload) { this._fanout(payload); }

    /** Host: authoritative game message to all peers */
    hostBroadcast(payload) { if (this.isHost) this._fanout(payload); }

    /** Peer: message to the host (actions, requests) */
    sendToHost(payload) {
        if (this.isHost) { this.onPeerMessage(this.me.id, this.me.name, payload); return; }
        const conn = this.conns.get(this.hostId);
        if (conn && conn.open) conn.send(payload);
    }

    playerIds() { return this.roster.map((p) => p.id); }

    toggleMic() {
        return this._toggleTrack("audio");
    }

    toggleCam() {
        return this._toggleTrack("video");
    }

    /** Host: broadcast an extra stream (screen share or local media) to every peer */
    startShare(stream, label) {
        if (!this.isHost) return;
        this.stopShare();
        this.shareStream = stream;
        this.shareLabel = label;
        this.roster.forEach((p) => { if (p.id !== this.me.id) this._ensureShareCall(p.id); });
        const vt = stream.getVideoTracks()[0];
        if (vt) vt.addEventListener("ended", () => this.stopShare());
    }

    stopShare() {
        this.shareCalls.forEach((c) => c.close());
        this.shareCalls.clear();
        if (this.shareStream) this.shareStream.getTracks().forEach((t) => t.stop());
        this.shareStream = null;
        this.shareLabel = null;
    }

    _ensureShareCall(peerId) {
        if (!this.shareStream || this.shareCalls.has(peerId)) return;
        const call = this.peer.call(peerId, this.shareStream, {
            metadata: { kind: "share", label: this.shareLabel }
        });
        this.shareCalls.set(peerId, call);
        call.on("close", () => this.shareCalls.delete(peerId));
        call.on("error", () => this.shareCalls.delete(peerId));
    }

    destroy() {
        try { this.conns.forEach((c) => c.close()); this.calls.forEach((c) => c.close()); } catch (_) {}
        if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
        if (this.peer) this.peer.destroy();
    }

    /* ---------- internals ---------- */

    _toggleTrack(kind) {
        if (!this.localStream) return false;
        const track = this.localStream.getTracks().find((t) => t.kind === kind);
        if (!track) return false;
        track.enabled = !track.enabled;
        return track.enabled;
    }

    async _getMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            this.mediaDenied = false;
        } catch (err) {
            // Join anyway in watch/chat mode — no crash, show a helper banner
            this.localStream = null;
            this.mediaDenied = true;
            console.warn("[p2p] camera/mic not granted:", err.name, err.message);
            this._mountDeniedNotice(err);
        }
    }

    /** Retry after the user flips the browser permission. Called from the banner button. */
    async retryMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
            return false;
        }
        this.mediaDenied = false;
        this._unmountDeniedNotice();
        // Start sending cam to everyone already in the room
        this.roster.forEach((p) => {
            if (p.id !== this.me.id && this.me.id < p.id) this._ensureCall(p.id);
        });
        this._ensureCall(this.hostId);
        this.onLocalStreamReady(this.localStream);
        return true;
    }

    _mountDeniedNotice(err) {
        this._unmountDeniedNotice();
        const el = document.createElement("div");
        el.style.cssText = `
            position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
            z-index: 200; max-width: 92vw;
            background: rgba(120, 30, 30, 0.95); color: #fff;
            border: 2px solid #ff6b6b; border-radius: 12px;
            padding: 10px 14px; font: 600 13px/1.4 Arial, sans-serif;
            display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        `;
        const span = document.createElement("span");
        span.textContent = "📷 Camera blocked — you're in watch mode. Click the 🔒 icon in your address bar, allow Camera + Microphone, then:";
        const btn = document.createElement("button");
        btn.textContent = "Enable Cam";
        btn.style.cssText = `
            background: linear-gradient(135deg,#00d4ff,#2b7780); color:#fff;
            border:none; border-radius:16px; padding:7px 16px;
            font:600 13px Arial,sans-serif; cursor:pointer;
        `;
        btn.addEventListener("click", async () => {
            btn.textContent = "Asking…";
            const ok = await this.retryMedia();
            if (!ok) btn.textContent = "Still blocked — check browser settings";
        });
        el.appendChild(span);
        el.appendChild(btn);
        document.body.appendChild(el);
        this._deniedNoticeEl = el;
    }

    _unmountDeniedNotice() {
        if (this._deniedNoticeEl) {
            this._deniedNoticeEl.remove();
            this._deniedNoticeEl = null;
        }
    }

    _randomCode() {
        const chars = "abcdefghjkmnpqrstuvwxyz23456789"; // no confusables
        let code = "";
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    }

    _waitOpen() {
        return new Promise((resolve, reject) => {
            this.peer.on("open", () => resolve());
            this.peer.on("error", (err) => {
                if (err.type === "peer-unavailable") {
                    reject(new Error("Room not found — double-check the code."));
                } else {
                    reject(err);
                }
            });
        });
    }

    _wireCommon() {
        this.peer.on("error", (err) => {
            if (err.type === "peer-unavailable") {
                this.onError(new Error("Couldn't reach a player — they may have left or the code is wrong."));
            }
        });

        // Incoming data channel
        this.peer.on("connection", (conn) => this._wireConn(conn));

        // Incoming video call
        this.peer.on("call", (call) => {
            call.answer(this.localStream || new MediaStream());

            // Host media-share calls are flagged in metadata
            if (call.metadata && call.metadata.kind === "share") {
                call.on("stream", (remote) => this.onShareStream(call.metadata.label, remote));
                call.on("close", () => this.onShareRemoved());
                call.on("error", () => this.onShareRemoved());
                return;
            }

            call.on("stream", (remote) => {
                const who = this._nameFor(call.peer);
                this.calls.set(call.peer, call);
                this.onStream(call.peer, who, remote);
            });
            call.on("close", () => this._dropCall(call.peer));
            call.on("error", () => this._dropCall(call.peer));
        });
    }

    _wireConn(conn) {
        conn.on("open", () => {
            // Directory probes get room info but never join the roster
            if (conn.metadata && conn.metadata.mode === "probe") {
                this.conns.set(conn.peer, conn);
                this._probes.add(conn.peer);
                return;
            }

            // Password rooms: bounce wrong/no password (host only)
            if (this.isHost && this.roomMeta.password &&
                !this.roster.some((p) => p.id === conn.peer)) {
                const supplied = (conn.metadata && conn.metadata.password) || "";
                if (supplied !== this.roomMeta.password) {
                    conn.send({ type: "__denied", reason: "password" });
                    setTimeout(() => conn.close(), 500);
                    return;
                }
            }

            // Room full? Politely bounce them (host only)
            if (this.isHost && this.roster.length >= this.maxPeers &&
                !this.roster.some((p) => p.id === conn.peer)) {
                conn.on("open", () => {
                    conn.send({ type: "__full" });
                    setTimeout(() => conn.close(), 500);
                });
                return;
            }

            this.conns.set(conn.peer, conn);

            // Host learns the peer's name from metadata and updates the roster
            if (this.isHost && !this.roster.some((p) => p.id === conn.peer)) {
                const name = (conn.metadata && conn.metadata.name) || this._anonName();
                this.roster.push({ id: conn.peer, name });
                this._fanout({ type: "__roster", roster: this.roster });
                this.onRosterChange(this.roster);
                // Late joiner while host is sharing media → beam it to them too
                this._ensureShareCall(conn.peer);
            }
        });

        conn.on("data", (msg) => {
            if (!msg || typeof msg !== "object") return;
            if (msg.type === "__denied") {
                this.onError(new Error("Wrong password — that room is locked. Check the password with your host."));
                return;
            }
            if (msg.type === "__full") {
                this.onError(new Error(`Lounge is full (${this.maxPeers} bros max). Try again later.`));
                return;
            }
            if (msg.type === "__roster" && !this.isHost) {
                this.roster = msg.roster;
                this.onRosterChange(this.roster);
                this._meshFromRoster();
                return;
            }
            if (msg.type === "__roomQuery" && this.isHost) {
                conn.send({
                    type: "__roomInfo",
                    prefix: this.prefix,
                    code: this.roomCode,
                    title: this.roomMeta.title,
                    players: this._playerCount(),
                    maxPlayers: this.maxPeers === Infinity ? null : this.maxPeers,
                    locked: !!this.roomMeta.password
                });
                return;
            }
            if (msg.type === "__roomInfo") { this.onAnyMessage(conn.peer, msg); return; }
            if (msg.type === "__roomBeacon" && this.isHost && this.prefix === "hub") {
                this._directoryUpdate(msg);
                return;
            }
            if (msg.type === "__directory" && !this.isHost) {
                this.onDirectory(msg.rooms || []);
                return;
            }

            this.onAnyMessage(conn.peer, msg);
            if (this.isHost) this.onPeerMessage(conn.peer, this._nameFor(conn.peer), msg);
            else if (conn.peer === this.hostId) this.onHostMessage(msg);
        });

        const drop = () => this._dropPeer(conn.peer);
        conn.on("close", drop);
        conn.on("error", drop);
    }

    _ensureData(otherId) {
        if (otherId === this.me.id) return;
        const existing = this.conns.get(otherId);
        if (existing && (existing.open || existing.peerConnection)) return;
        const conn = this.peer.connect(otherId, {
            reliable: true,
            metadata: { name: this.me.name }
        });
        this._wireConn(conn);
    }

    _ensureCall(otherId) {
        if (!this.mediaEnabled) return;
        if (otherId === this.me.id) return;
        if (this.calls.has(otherId)) return;
        // Empty stream when cam is denied — we still RECEIVE their video
        const stream = this.localStream || new MediaStream();
        const call = this.peer.call(otherId, stream);
        this.calls.set(otherId, call);
        call.on("stream", (remote) => this.onStream(otherId, this._nameFor(otherId), remote));
        call.on("close", () => this._dropCall(otherId));
        call.on("error", () => this._dropCall(otherId));
    }

    /** After receiving the roster, mesh up: lower id initiates both conn + call */
    _meshFromRoster() {
        this.roster.forEach((p) => {
            if (p.id === this.me.id) return;
            if (this.me.id < p.id) {
                this._ensureData(p.id);
                this._ensureCall(p.id);
            } else {
                // ensure data to host at minimum (actions go via host)
                if (p.id === this.hostId) this._ensureData(p.id);
            }
        });
    }

    _fanout(payload) {
        this.conns.forEach((conn) => {
            if (conn.open) conn.send(payload);
        });
    }

    _dropCall(peerId) {
        this.calls.delete(peerId);
        this.onStreamRemoved(peerId);
    }

    _dropPeer(peerId) {
        const was = this.conns.delete(peerId);
        this._dropCall(peerId);
        if (!was) return;

        const name = this._nameFor(peerId);
        if (this.isHost) {
            this.roster = this.roster.filter((p) => p.id !== peerId);
            this._fanout({ type: "__roster", roster: this.roster });
            this.onRosterChange(this.roster);
        } else if (peerId === this.hostId) {
            this.onHostGone();
        }
        this.onPeerGone(peerId, name);
    }

    _nameFor(peerId) {
        const found = this.roster.find((p) => p.id === peerId);
        return found ? found.name : this._anonName();
    }

    _anonName() { return "Gooner " + Math.floor(Math.random() * 90 + 10); }

    /* ============ Hub presence + room directory (beacons) ============ */

    _playerCount() {
        // probes never join the roster, so roster length is accurate
        return this.roster.length;
    }

    /**
     * Connect to the global "hub" presence room. Whoever grabs the fixed
     * room ID becomes the hub host (directory keeper); everyone else joins.
     * Used by: landing visitors (presence count + room directory) and game
     * hosts (advertising their room).
     */
    async connectHub(name = "") {
        const wire = (hub) => {
            hub.onRosterChange = (roster) => {
                this.onHubRoster(roster);
                if (hub.isHost) hub._broadcastDirectory();
            };
            hub.onDirectory = (rooms) => this.onDirectory(rooms);
        };

        this._hub = new P2PRoom({ prefix: "hub", requireMedia: false });
        wire(this._hub);
        try {
            await this._hub.host(name || "Hub Host", { code: "lobby", requireMedia: false });
            this._hub._startDirectoryBroadcast();
        } catch (err) {
            // fixed ID taken → join as a member instead
            this._hub = new P2PRoom({ prefix: "hub", requireMedia: false });
            wire(this._hub);
            await this._hub.join(name || "Gooner " + Math.floor(Math.random() * 900 + 100),
                "lobby", "", { requireMedia: false });
        }
        return this._hub;
    }

    /** Override: called with the hub roster whenever Anyone joins/leaves the hub. */
    onHubRoster(_roster) {}

    /** Override: called with the live public-room directory. */
    onDirectory(_rooms) {}

    /* --- hub-host internals --- */

    _startDirectoryBroadcast() {
        this._directory = this._directory || new Map();
        this._dirTimer = setInterval(() => this._broadcastDirectory(), 10000);
        this._broadcastDirectory();
    }

    _directoryUpdate(beacon) {
        if (!this._directory) this._directory = new Map();
        const key = `${beacon.prefix}-${beacon.code}`;
        if ((beacon.players || 0) <= 0) this._directory.delete(key);
        else this._directory.set(key, { ...beacon, seenAt: Date.now() });
        this._broadcastDirectory();
    }

    _broadcastDirectory() {
        if (!this._directory) return;
        const now = Date.now();
        // prune rooms silent for >60s
        for (const [key, r] of this._directory) {
            if (now - (r.seenAt || 0) > 60000) this._directory.delete(key);
        }
        const rooms = [...this._directory.values()];
        this._fanout({ type: "__directory", rooms });
        if (typeof this.onDirectory === "function") this.onDirectory(rooms);
    }

    /* --- room advertising (game hosts) --- */

    /**
     * Connect to the hub in the background and start advertising this room,
     * retrying on failure (PeerJS cloud has slow/busy days).
     * Games call this instead of `connectHub().then(advertiseRoom)`.
     */
    advertiseWhenReady(attempt = 1) {
        if (this._hub && this._advTimer) return; // already advertising
        this.connectHub((this.me && this.me.name) || "")
            .then(() => this.advertiseRoom())
            .catch((err) => {
                if (attempt >= 30) return; // ~10 min of trying, then give up quietly
                const delay = Math.min(attempt * 5000, 30000);
                setTimeout(() => this.advertiseWhenReady(attempt + 1), delay);
            });
    }

    advertiseRoom() {
        if (!this.isHost || !this._hub || this._advTimer) return;
        const send = () => {
            if (!this.roomMeta.listed) return;
            this._hub.sendAll({
                type: "__roomBeacon",
                prefix: this.prefix,
                code: this.roomCode,
                title: this.roomMeta.title,
                players: this.roster.length,
                locked: !!this.roomMeta.password,
                maxPlayers: this.maxPeers === Infinity ? null : this.maxPeers
            });
        };
        send();
        this._advTimer = setInterval(send, 15000);
        // Re-beacon whenever the roster changes so player counts stay fresh
        const prev = this.onRosterChange;
        this.onRosterChange = (roster) => { prev(roster); send(); };
    }

    stopAdvertising() {
        if (this._advTimer) clearInterval(this._advTimer);
    }

    destroy() {
        this.stopAdvertising();
        if (this._dirTimer) clearInterval(this._dirTimer);
        if (this._hub) this._hub.destroy();
        try { this.conns.forEach((c) => c.close()); this.calls.forEach((c) => c.close()); } catch (_) {}
        if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
        if (this.peer) this.peer.destroy();
    }
}

/* ============================================================
   Chat UI — mountChatUI(rootEl, { onSend })
   Reusable floating chat panel: unread badge, message list.
   ============================================================ */

function mountChatUI(rootEl, { onSend, selfName }) {
    rootEl.innerHTML = `
        <button class="chat-fab" id="chatFab" title="Chat">
            💬 <span class="chat-badge hidden" id="chatBadge"></span>
        </button>
        <div class="chat-panel hidden" id="chatPanel">
            <div class="chat-header">
                <span>Battle Chat</span>
                <button class="chat-close" id="chatClose">×</button>
            </div>
            <div class="chat-messages" id="chatMessages"></div>
            <form class="chat-input-row" id="chatForm">
                <input type="text" id="chatInput" class="chat-input" placeholder="Talk dirty…" maxlength="240" autocomplete="off">
                <button type="submit" class="chat-send">➤</button>
            </form>
        </div>
    `;

    const fab = rootEl.querySelector("#chatFab");
    const badge = rootEl.querySelector("#chatBadge");
    const panel = rootEl.querySelector("#chatPanel");
    const messages = rootEl.querySelector("#chatMessages");
    const form = rootEl.querySelector("#chatForm");
    const input = rootEl.querySelector("#chatInput");
    let unread = 0;

    const toggle = (open) => {
        panel.classList.toggle("hidden", !open);
        if (open) {
            unread = 0;
            badge.classList.add("hidden");
            input.focus();
        }
    };
    fab.addEventListener("click", () => toggle(panel.classList.contains("hidden")));
    rootEl.querySelector("#chatClose").addEventListener("click", () => toggle(false));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        onSend(text);
    });

    function addMessage({ name, text, self = false, system = false }) {
        const row = document.createElement("div");
        row.className = "chat-msg" + (self ? " chat-self" : "") + (system ? " chat-system" : "");
        if (system) {
            row.textContent = text;
        } else {
            row.innerHTML = `<span class="chat-msg-name"></span><span class="chat-msg-text"></span>`;
            row.querySelector(".chat-msg-name").textContent = name + ": ";
            row.querySelector(".chat-msg-text").textContent = text;
        }
        messages.appendChild(row);
        messages.scrollTop = messages.scrollHeight;

        if (panel.classList.contains("hidden") && !self && !system) {
            unread++;
            badge.textContent = unread > 9 ? "9+" : unread;
            badge.classList.remove("hidden");
        }
    }

    return { addMessage, selfName };
}
