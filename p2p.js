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
    constructor({ prefix = "bg", maxVideoTiles = 6, maxPeers = Infinity } = {}) {
        this.prefix = prefix;
        this.maxVideoTiles = maxVideoTiles;
        this.maxPeers = maxPeers;

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

        // ---- callbacks (set by the game) ----
        this.onRosterChange = () => {};
        this.onHostMessage = () => {};      // peers: messages FROM host
        this.onPeerMessage = () => {};      // host: messages FROM a peer
        this.onAnyMessage = () => {};       // everyone: chat etc.
        this.onStream = () => {};           // (peerId, name, MediaStream)
        this.onStreamRemoved = () => {};    // (peerId)
        this.onShareStream = () => {};      // (label, MediaStream) — peers: host started sharing
        this.onShareRemoved = () => {};     // share ended
        this.onPeerGone = () => {};         // (peerId, name)
        this.onHostGone = () => {};
        this.onError = () => {};
    }

    /* ---------- public API ---------- */

    async host(name) {
        await this._getMedia();
        this.isHost = true;
        this.roomCode = this._randomCode();
        this.hostId = `${this.prefix}-${this.roomCode}`;
        this.peer = new Peer(this.hostId, { config: { iceServers: ICE_SERVERS } });
        await this._waitOpen();
        this.me = { id: this.hostId, name };
        this.roster = [this.me];
        this._wireCommon();
        return this.shareLink();
    }

    async join(name, code) {
        await this._getMedia();
        this.isHost = false;
        this.roomCode = code.toLowerCase();
        this.hostId = `${this.prefix}-${this.roomCode}`;
        this.peer = new Peer({ config: { iceServers: ICE_SERVERS } });
        await this._waitOpen();
        this.me = { id: this.peer.id, name };
        this._wireCommon();

        // Connect to host; roster comes back and we mesh from there
        this._ensureData(this.hostId);
        this._ensureCall(this.hostId); // always call the host so they see/hear us ASAP
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
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
            call.answer(this.localStream);

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
        if (otherId === this.me.id || !this.localStream) return;
        if (this.calls.has(otherId)) return;
        const call = this.peer.call(otherId, this.localStream);
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
