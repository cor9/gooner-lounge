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

        // Host kick support: kicked peer ids are re-bounced if they come back
        this._banned = new Set();

        // Hub heartbeat state: members ping, the host reaps ghosts fast
        this._lastSeen = new Map();  // peerId -> timestamp (host side, hub-only)
        this._hbInterval = null;

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
        this._mountRoomBadge();
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
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => this._finishJoin(new Error("The host did not respond. Try again or ask for a fresh room link.")), 20000);
            this._pendingJoin = (err) => {
                clearTimeout(timer);
                this._pendingJoin = null;
                if (err) reject(err); else resolve();
            };
            this._ensureData(this.hostId);
        }).catch((err) => { this.destroy(); throw err; });
        if (this.mediaEnabled) this._ensureCall(this.hostId); // cam to host first
        this._mountRoomBadge();
        return null;
    }

    /** Floating room-code pill (top-right) — visible for the whole session. */
    _mountRoomBadge() {
        if (this.prefix === "hub" || this._roomBadgeEl) return;
        const code = this.roomCode;
        const el = document.createElement("button");
        el.style.cssText = `
            position: fixed; top: 14px; right: 14px; z-index: 100;
            display: inline-flex; align-items: center; gap: 7px;
            background: rgba(20, 30, 40, 0.85);
            border: 1px solid rgba(0, 212, 255, 0.35);
            color: #00d4ff;
            font: 600 13px/1 Arial, sans-serif; letter-spacing: 0.5px;
            padding: 8px 14px; border-radius: 20px; cursor: pointer;
        `;
        el.innerHTML = `🎟️ <b>${code}</b>`;
        el.title = "Room " + code + " — tap to copy invite link";
        el.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(this.shareLink());
                el.innerHTML = "✅ invite copied!";
            } catch (_) {
                el.innerHTML = this.shareLink();
            }
            setTimeout(() => { el.innerHTML = `🎟️ <b>${code}</b>`; }, 1800);
        });
        document.body.appendChild(el);
        this._roomBadgeEl = el;
    }

    _unmountRoomBadge() {
        if (this._roomBadgeEl) {
            this._roomBadgeEl.remove();
            this._roomBadgeEl = null;
        }
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

    /** Host: remove a peer from the room (and keep them out this session). */
    kickPeer(peerId) {
        if (!this.isHost || peerId === this.me.id) return;
        const conn = this.conns.get(peerId);
        if (conn && conn.open) conn.send({ type: "__kick" });
        setTimeout(() => {
            try { conn && conn.close(); } catch (_) {}
        }, 400);
        this._banned.add(peerId);
        this._dropPeer(peerId);
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
            this.localStream.getAudioTracks().forEach(track => { track.enabled = false; });
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
        this.localStream.getAudioTracks().forEach(track => { track.enabled = false; });
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

    _finishJoin(err) {
        if (this._pendingJoin) this._pendingJoin(err);
    }

    _waitOpen() {
        const peer = this.peer;
        return new Promise((resolve, reject) => {
            const finish = (err) => {
                clearTimeout(timer);
                peer.off("open", opened);
                peer.off("error", failed);
                if (err) { peer.destroy(); reject(err); } else resolve();
            };
            const opened = () => finish();
            const failed = (err) => finish(err);
            const timer = setTimeout(() => finish(new Error("Connection timed out. Please try again.")), 15000);
            peer.on("open", opened);
            peer.on("error", failed);
        });
    }

    _wireCommon() {
        this.peer.on("error", (err) => {
            this._finishJoin(err);
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
            // Host ban-list: previously-kicked peer coming back? bounce again
            if (this.isHost && this._banned.has(conn.peer)) {
                conn.send({ type: "__banned" });
                setTimeout(() => conn.close(), 400);
                return;
            }

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
                conn.send({ type: "__full" });
                setTimeout(() => conn.close(), 500);
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
            if (msg.type === "__kick" || msg.type === "__banned") {
                alert("The host removed you from the room.");
                this.destroy();
                location.hash = "";
                location.reload();
                return;
            }
            if (msg.type === "__denied") {
                const err = new Error("Wrong password — that room is locked. Check the password with your host.");
                this._finishJoin(err);
                this.onError(err);
                return;
            }
            if (msg.type === "__full") {
                const err = new Error("This room is full. Try another room.");
                this._finishJoin(err);
                this.onError(err);
                return;
            }
            if (msg.type === "__roster" && !this.isHost && conn.peer === this.hostId) {
                this.roster = msg.roster;
                if (this.roster.some((p) => p.id === this.me.id)) this._finishJoin();
                this.onRosterChange(this.roster);
                this._meshFromRoster();
                return;
            }
            if (msg.type === "__hb" && this.isHost && this.prefix === "hub") {
                this._lastSeen.set(conn.peer, Date.now());
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

        const drop = () => {
            if (conn.peer === this.hostId) this._finishJoin(new Error("The room connection closed. Please try again."));
            this._dropPeer(conn.peer);
        };
        conn.on("close", drop);
        conn.on("error", drop);
    }

    _ensureData(otherId) {
        if (otherId === this.me.id) return;
        const existing = this.conns.get(otherId);
        if (existing && (existing.open || existing.peerConnection)) return;
        const conn = this.peer.connect(otherId, {
            reliable: true,
            metadata: { name: this.me.name, password: otherId === this.hostId ? this.password : "" }
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
        } else if (peerId === this.hostId && !this._destroyed) {
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
        if (this._destroyed) throw new Error("Connection closed.");
        if (this._hub) this._hub.destroy();
        const wire = (hub) => {
            hub.onError = (err) => {
                this.onError(err);
                // A dead/zombie hub host on the broker: revive instead of giving up.
                // If we keep trying long enough, one participant will eventually host
                // the directory themselves and the room beacons can flow again.
                if (err && err.type === "peer-unavailable") this._scheduleHubReconnect(name);
            };
            hub.onHostGone = () => { this.onHubStatus("reconnecting"); this._scheduleHubReconnect(name); };
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
            this._hub._startGhostReaper();
            this.onHubRoster(this._hub.roster);
        } catch (err) {
            // Only a claimed ID means another browser owns the directory.
            this._hub.destroy();
            if (err.type !== "unavailable-id") throw err;
            this._hub = new P2PRoom({ prefix: "hub", requireMedia: false });
            wire(this._hub);
            await this._hub.join(name || "Gooner " + Math.floor(Math.random() * 900 + 100),
                "lobby", "", { requireMedia: false });
        }
        this._hub._startHeartbeatPing();
        return this._hub;
    }

    _scheduleHubReconnect(name) {
        if (this._destroyed || this._hubRetry) return;
        this._hubRetry = setTimeout(() => {
            this._hubRetry = null;
            this.connectHub(name).catch((err) => {
                this.onError(err);
                this._scheduleHubReconnect(name);
            });
        }, 1000 + Math.random() * 2000);
    }

    /** Override: called with the hub roster whenever Anyone joins/leaves the hub. */
    onHubRoster(_roster) {}

    onHubStatus(_status) {}

    /** Override: called with the live public-room directory. */
    onDirectory(_rooms) {}

    /* --- hub-host internals --- */

    _startDirectoryBroadcast() {
        this._directory = this._directory || new Map();
        this._dirTimer = setInterval(() => this._broadcastDirectory(), 10000);
        this._broadcastDirectory();
    }

    /* --- hub heartbeat: kill stale roster entries within ~45s --- */

    _startGhostReaper() {
        if (this.prefix !== "hub" || !this.isHost) return;
        this._lastSeen.set(this.me.id, Date.now());
        this._hbSweep = setInterval(() => {
            const now = Date.now();
            const before = this.roster.length;
            this.roster = this.roster.filter((p) => {
                if (p.id === this.me.id) { this._lastSeen.set(p.id, now); return true; }
                const last = this._lastSeen.get(p.id) || 0;
                const conn = this.conns.get(p.id);
                // keep only members with a recent heartbeat AND an open data conn
                return conn && conn.open && now - last < 45000;
            });
            if (this.roster.length !== before) {
                this._fanout({ type: "__roster", roster: this.roster });
                this.onRosterChange(this.roster);
                if (this._broadcastDirectory) this._broadcastDirectory();
            }
        }, 10000);
    }

    _startHeartbeatPing() {
        if (this.prefix !== "hub" || this.isHost) return;
        const ping = () => this.sendAll({ type: "__hb" });
        this._hbInterval = setInterval(ping, 10000);
        setTimeout(ping, 2500); // announce yourself soon after joining
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
     * Advertise this room to the HTTP directory (batorgames-livekit service).
     * No hub-host election roulette: beacons land on an always-on server.
     * Still connects to the hub room in the background for presence/robustness.
     */
    advertiseWhenReady() {
        const DIRECTORY_URL = (window.DIRECTORY_URL || "https://livekit-token-dnuo.onrender.com");
        const send = async () => {
            if (!this.isHost) return;
            const locked = !!this.roomMeta.password;
            try {
                await fetch(DIRECTORY_URL + "/beacon", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        prefix: this.prefix,
                        code: this.roomCode,
                        title: this.roomMeta.title,
                        players: locked ? 0 : this.roster.length, // unlisted = players 0 (drops out)
                        locked,
                        maxPlayers: this.maxPeers === Infinity ? null : this.maxPeers,
                        hubPeerId: (this.me && this.me.id) || null,
                        members: locked ? [] : this.roster.map((p) => ({ id: p.id, name: p.name }))
                    })
                });
            } catch (_) { /* server asleep — next tick retries */ }
        };
        send();
        this._advTimer = setInterval(send, 15000);
        const prev = this.onRosterChange;
        this.onRosterChange = (roster) => { prev(roster); send(); };

        // presence still rides the hub room as before, in the background
        this.connectHub((this.me && this.me.name) || "").catch(() => {});
    }

    stopAdvertising() {
        if (this._advTimer) clearInterval(this._advTimer);
    }

    destroy() {
        this._destroyed = true;
        clearTimeout(this._hubRetry);
        clearTimeout(this._advRetry);
        this._finishJoin(new Error("Connection closed."));
        this.stopAdvertising();
        this._unmountRoomBadge();
        if (this._dirTimer) clearInterval(this._dirTimer);
        if (this._hbInterval) clearInterval(this._hbInterval);
        if (this._hbSweep) clearInterval(this._hbSweep);
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
