/* ============================================================
   lk.js — Bator Games shared LiveKit media layer
   Cams, mic, screen share, and local-file sharing via LiveKit
   Cloud SFU (TURN relay included — no NAT pain).

   Game sync/chat stays on p2p.js data channels; this module
   is media only. Tile identity = the game's p2p peer id, so
   tiles map 1:1 to the roster everywhere.
   ============================================================ */

const LK_URL = "wss://batorgames-b07ix70y.livekit.cloud";
// Flipped to the Render URL once batorgames-livekit-token is deployed:
const LK_TOKEN_URL = window.LK_TOKEN_URL || "https://livekit-token-dnuo.onrender.com/token";

class LKMedia {
    constructor({ url = LK_URL, tokenUrl = LK_TOKEN_URL } = {}) {
        this.url = url;
        this.tokenUrl = tokenUrl;
        this.room = null;
        this.identity = null;
        this.displayName = null;

        this.streams = new Map(); // identity -> MediaStream (remote cams)
        this.shareStreams = new Map(); // identity -> MediaStream (screen/file shares)
        this.participantNames = new Map(); // identity -> display name

        this.mediaDenied = false;
        this._deniedNoticeEl = null;

        // ---- callbacks (set by the game) ----
        this.onTile = () => {};        // (identity, name, MediaStream, isLocal)
        this.onRemoveTile = () => {};  // (identity)
        this.onShare = () => {};       // (label, MediaStream) — remote screen/file share
        this.onShareEnd = () => {};
        this.onConnected = () => {};
        this.onError = () => {};
    }

    isCamTrack(pub) {
        return pub.source === LivekitClient.Track.Source.Camera ||
               pub.source === LivekitClient.Track.Source.Microphone;
    }

    /* ---------------- connect ---------------- */

    async connect(roomName, identity, displayName) {
        this.identity = identity;
        this.displayName = displayName;

        let token;
        try {
            const params = new URLSearchParams({ room: roomName, identity, name: displayName });
            const res = await fetch(`${this.tokenUrl}?${params}`);
            if (!res.ok) throw new Error("token service returned " + res.status);
            token = (await res.json()).token;
        } catch (err) {
            this.onError(new Error("Couldn't get a cam token. Wait a few seconds and try again."));
            return false;
        }

        this.room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
        this._wireEvents();

        try {
            await this.room.connect(this.url, token);
        } catch (err) {
            this.onError(new Error("Couldn't connect to the cam service."));
            return false;
        }

        // fire connected BEFORE media so the game can render lobby/UI
        this.onConnected();

        // Camera only. The microphone is published only after an explicit unmute.
        try {
            await this.room.localParticipant.setCameraEnabled(true);
            this.mediaDenied = false;
        } catch (err) {
            this.mediaDenied = true;
            this._mountDeniedNotice();
        }
        return true;
    }

    /** Retry after the user flips browser permission (denial banner button). */
    async retryMedia() {
        if (!this.room) return false;
        try {
            await this.room.localParticipant.setCameraEnabled(true);
        } catch (err) {
            return false;
        }
        this.mediaDenied = false;
        this._unmountDeniedNotice();
        return true;
    }

    /* ---------------- tracks -> tiles ---------------- */

    _wireEvents() {
        const RoomEvent = LivekitClient.RoomEvent;

        this.room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
            const identity = participant.identity;
            this.participantNames.set(identity, participant.name || identity);

            if (!this.isCamTrack(pub)) {
                // screen share or file share (video + share-audio accumulate)
                const label = pub.source === LivekitClient.Track.Source.ScreenShare
                    ? "screen share"
                    : (pub.trackName || "media").replace(/^share:/, "") || "media";
                let s = this.shareStreams.get(identity);
                if (!s) {
                    s = new MediaStream();
                    this.shareStreams.set(identity, s);
                }
                s.addTrack(track.mediaStreamTrack);
                this.onShare(label, s);
                return;
            }

            // cam or mic: accumulate onto a per-participant stream
            let stream = this.streams.get(identity);
            if (!stream) {
                stream = new MediaStream();
                this.streams.set(identity, stream);
            }
            stream.addTrack(track.mediaStreamTrack);
            this.onTile(identity, this.participantNames.get(identity), stream, false);

            track.on("ended", () => {
                const s = this.streams.get(identity);
                if (s) {
                    s.removeTrack(track.mediaStreamTrack);
                    if (s.getTracks().length === 0) {
                        this.streams.delete(identity);
                        this.onRemoveTile(identity);
                    }
                }
            });
        });

        this.room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
            const identity = participant.identity;
            if (!this.isCamTrack(pub)) {
                const s = this.shareStreams.get(identity);
                if (s) s.removeTrack(track.mediaStreamTrack);
                if (track.kind === "video") {
                    this.shareStreams.delete(identity);
                    this.onShareEnd();
                }
                return;
            }
            const s = this.streams.get(identity);
            if (s) {
                s.removeTrack(track.mediaStreamTrack);
                if (s.getTracks().length === 0) {
                    this.streams.delete(identity);
                    this.onRemoveTile(identity);
                }
            }
        });

        this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            const identity = participant.identity;
            this.streams.delete(identity);
            if (this.shareStreams.delete(identity)) this.onShareEnd();
            this.participantNames.delete(identity);
            this.onRemoveTile(identity);
        });

        this.room.on(RoomEvent.LocalTrackPublished, (pub) => {
            if (pub.source === LivekitClient.Track.Source.Camera) {
                this.onTile(this.identity, this.displayName + " (you)", this._localStream(), true);
            }
        });

        this.room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
            if (pub.source === LivekitClient.Track.Source.Camera) {
                // keep the tile (mic may still be live) but blank the video
                this.onTile(this.identity, this.displayName + " (you)", this._localStream(), true);
            }
        });

        this.room.on(RoomEvent.Disconnected, () => {
            [...this.streams.keys()].forEach((id) => this.onRemoveTile(id));
            this.streams.clear();
            this.onShareEnd();
        });
    }

    _localStream() {
        const tracks = [];
        this.room.localParticipant.trackPublications.forEach((pub) => {
            if (pub.track && pub.isSubscribed !== false && pub.track.mediaStreamTrack) {
                tracks.push(pub.track.mediaStreamTrack);
            }
        });
        return new MediaStream(tracks);
    }

    /* ---------------- sharing (host screen/file) ---------------- */

    /** Share the screen (LiveKit native screen share). Returns false if cancelled. */
    async shareScreen() {
        if (!this.room) return false;
        try {
            await this.room.localParticipant.setScreenShareEnabled(true, { audio: true });
            return true;
        } catch (err) {
            return false;
        }
    }

    async stopScreenShare() {
        if (!this.room) return;
        await this.room.localParticipant.setScreenShareEnabled(false);
    }

    /** Share a local mp3/mp4 via captureStream(). label shows to viewers. */
    async shareStream(mediaStream, label) {
        if (!this.room) return false;
        for (const track of mediaStream.getTracks()) {
            const localTrack = new LivekitClient.LocalTrack(track, track.kind, undefined, "share:" + label);
            await this.room.localParticipant.publishTrack(localTrack, {
                name: "share:" + label,
                source: track.kind === "video" ? LivekitClient.Track.Source.Unknown : LivekitClient.Track.Source.Microphone
            });
        }
        // local echo label
        return true;
    }

    async stopShareStream() {
        if (!this.room) return;
        const pubs = [];
        this.room.localParticipant.trackPublications.forEach((pub) => {
            if ((pub.trackName || "").startsWith("share:")) pubs.push(pub);
        });
        for (const pub of pubs) {
            try { await this.room.localParticipant.unpublishTrack(pub.track); } catch (_) {}
        }
    }

    /** Your own share as a MediaStream (for local preview). Null if not sharing. */
    localShareStream() {
        if (!this.room) return null;
        const tracks = [];
        this.room.localParticipant.trackPublications.forEach((pub) => {
            if (!this.isCamTrack(pub) && pub.track && pub.track.mediaStreamTrack) {
                tracks.push(pub.track.mediaStreamTrack);
            }
        });
        return tracks.length ? new MediaStream(tracks) : null;
    }

    /* ---------------- controls ---------------- */

    syncMicControls() {
        const lp = this.room && this.room.localParticipant;
        if (!lp) return;
            document.querySelectorAll('#toggleMicBtn, #toggle-mic').forEach(button => {
                button.classList.toggle('media-off', !lp.isMicrophoneEnabled);
                button.setAttribute('aria-pressed', String(lp.isMicrophoneEnabled));
                button.setAttribute('aria-label', lp.isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone');
                button.title = lp.isMicrophoneEnabled ? 'Microphone on — click to mute' : 'Microphone muted — click to unmute';
            });
    }

    async toggleMic() {
        const lp = this.room && this.room.localParticipant;
        if (!lp) return false;
        try {
            await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
            this.syncMicControls();
            return lp.isMicrophoneEnabled;
        } catch (_) { return false; }
    }

    async toggleCam() {
        const lp = this.room && this.room.localParticipant;
        if (!lp) return false;
        try {
            await lp.setCameraEnabled(!lp.isCameraEnabled);
            return lp.isCameraEnabled;
        } catch (_) { return false; }
    }

    disconnect() {
        if (this.room) this.room.disconnect();
        this.room = null;
    }

    /* ---------------- denial banner ---------------- */

    _mountDeniedNotice() {
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
}

/* ============================================================
   Spotlight + PiP + tile actions (mute/hide/kick)
   Games configure once:
     window.LK_TILE_CONFIG = {
        isHost: () => boolean,
        kick:   (peerId) => void,
        selfId: () => string|null
     };
   ============================================================ */

const LK_SPOT_CSS = `
.lk-spot-overlay {
    position: fixed; inset: 0; z-index: 300;
    background: rgba(0,0,0,0.82);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 20px;
}
.lk-spot-overlay video {
    max-width: min(92vw, 1100px); max-height: 76vh;
    border-radius: 14px; border: 3px solid #00d4ff;
    box-shadow: 0 0 60px rgba(0,212,255,0.25);
    background: #000; object-fit: contain;
}
.lk-spot-label { color: #fff; font: 700 16px Arial; }
.lk-spot-btns { display: flex; gap: 10px; }
.lk-spot-btn {
    background: linear-gradient(135deg,#00d4ff,#2b7780); color: #fff;
    border: none; border-radius: 20px; padding: 9px 20px;
    font: 600 13px Arial; cursor: pointer;
}
.lk-spot-btn.lk-spot-close { background: #444; }
.lk-pip {
    position: fixed; z-index: 300;
    right: 16px; bottom: 92px;
    width: 240px; border-radius: 12px; overflow: hidden;
    border: 2px solid #00d4ff; box-shadow: 0 12px 30px rgba(0,0,0,0.6);
    background: #000;
}
.lk-pip-head {
    background: rgba(20,30,40,0.95); color: #9adcf5;
    font: 600 11px Arial; padding: 5px 8px;
    display: flex; justify-content: space-between; align-items: center;
    cursor: grab; user-select: none;
}
.lk-pip-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-pip-close { background: none; border: none; color: #ff6b6b; font: 700 13px Arial; cursor: pointer; }
.lk-pip video { width: 100%; display: block; }
.lk-tile-actions {
    position: absolute; top: 4px; right: 4px;
    display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s;
}
.video-tile:hover .lk-tile-actions { opacity: 1; }
.lk-tile-act {
    width: 26px; height: 26px; border-radius: 50%;
    background: rgba(20,30,40,0.9); border: 1px solid rgba(0,212,255,0.4);
    color: #fff; font-size: 12px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    padding: 0;
}
.lk-tile-act.lk-kick-btn { border-color: #ff6b6b; }
.video-tile.lk-tile-hidden { aspect-ratio: auto; height: 26px; overflow: hidden; }
.video-tile.lk-tile-hidden video { display: none; }
.video-tile.lk-muted .tile-label::after { content: " 🔇"; }
`;

let _lkSpotStyleMounted = false;
function _mountSpotStyle() {
    if (_lkSpotStyleMounted) return;
    const s = document.createElement("style");
    s.textContent = LK_SPOT_CSS;
    document.head.appendChild(s);
    _lkSpotStyleMounted = true;
}

function openSpotlight(stream, label) {
    if (!stream) return;
    _mountSpotStyle();
    document.querySelectorAll(".lk-spot-overlay").forEach((n) => n.remove());

    const overlay = document.createElement("div");
    overlay.className = "lk-spot-overlay";
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true; video.srcObject = stream;

    const labelEl = document.createElement("div");
    labelEl.className = "lk-spot-label";
    labelEl.textContent = label || "";

    const btns = document.createElement("div");
    btns.className = "lk-spot-btns";
    btns.innerHTML = `
        <button class="lk-spot-btn lk-spot-float">⤿ Float</button>
        <button class="lk-spot-btn lk-spot-close">✖ Close</button>`;
    overlay.append(video, labelEl, btns);
    document.body.appendChild(overlay);

    btns.querySelector(".lk-spot-close").addEventListener("click", () => overlay.remove());
    btns.querySelector(".lk-spot-float").addEventListener("click", () => {
        makeFloatingPiP(stream, label);
        overlay.remove();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    const esc = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
}

function makeFloatingPiP(stream, label) {
    if (!stream) return;
    _mountSpotStyle();

    const pip = document.createElement("div");
    pip.className = "lk-pip";
    const head = document.createElement("div");
    head.className = "lk-pip-head";
    head.innerHTML = `<span></span><button class="lk-pip-close">✖</button>`;
    head.querySelector("span").textContent = label || "cam";
    head.querySelector(".lk-pip-close").addEventListener("click", () => pip.remove());

    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true; video.srcObject = stream;

    pip.append(head, video);
    document.body.appendChild(pip);

    head.addEventListener("pointerdown", (e) => {
        head.setPointerCapture(e.pointerId);
        const rect = pip.getBoundingClientRect();
        pip.style.right = "auto"; pip.style.bottom = "auto";
        pip.style.left = rect.left + "px"; pip.style.top = rect.top + "px";
        const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
        const move = (ev) => {
            pip.style.left = Math.max(0, ev.clientX - offX) + "px";
            pip.style.top = Math.max(0, ev.clientY - offY) + "px";
        };
        const up = () => {
            head.removeEventListener("pointermove", move);
            head.removeEventListener("pointerup", up);
            head.removeEventListener("pointercancel", up);
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
    });
    return pip;
}

/* ---------- per-tile action buttons ---------- */

function _lkDecorateTile(tile) {
    if (tile.dataset.lkDecorated) return;
    tile.dataset.lkDecorated = "1";

    const acts = document.createElement("div");
    acts.className = "lk-tile-actions";
    const peerId = tile.dataset.peer;
    const cfg = window.LK_TILE_CONFIG || {};
    const video = tile.querySelector("video");

    // local mute (viewer-side: silences THIS person's audio on YOUR device)
    const muteBtn = document.createElement("button");
    muteBtn.className = "lk-tile-act";
    muteBtn.title = "Mute this cam on your screen";
    muteBtn.textContent = "🔊";
    muteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? "🔇" : "🔊";
        tile.classList.toggle("lk-muted", video.muted);
    });

    // hide camera view (viewer-side)
    const hideBtn = document.createElement("button");
    hideBtn.className = "lk-tile-act";
    hideBtn.title = "Hide this cam on your screen";
    hideBtn.textContent = "🙈";
    hideBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const hidden = tile.classList.toggle("lk-tile-hidden");
        hideBtn.textContent = hidden ? "👁" : "🙈";
    });

    acts.append(muteBtn, hideBtn);

    // host kick
    if (cfg.isHost && cfg.kick && cfg.selfId &&
        cfg.isHost() && peerId !== cfg.selfId()) {
        const kickBtn = document.createElement("button");
        kickBtn.className = "lk-tile-act lk-kick-btn";
        kickBtn.title = "Remove from room (host)";
        kickBtn.textContent = "✖";
        kickBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const name = (tile.querySelector(".tile-label") || {}).textContent || peerId;
            if (confirm(`Remove ${name} from the room?`)) cfg.kick(peerId);
        });
        acts.appendChild(kickBtn);
    }

    tile.appendChild(acts);
}

// decorate tiles as they appear (delegated observer — no game edits needed)
document.addEventListener("DOMContentLoaded", () => {
    _mountSpotStyle();

    const decorateAll = () => {
        document.querySelectorAll(".video-tile:not([data-lk-decorated])").forEach(_lkDecorateTile);
    };

    new MutationObserver(decorateAll).observe(document.body, { childList: true, subtree: true });
    decorateAll();

    // spotlight on tile click (not when hitting the action buttons)
    document.addEventListener("click", (e) => {
        if (e.target.closest(".lk-tile-actions")) return;
        const tile = e.target.closest(".video-tile");
        if (!tile) return;
        const video = tile.querySelector("video");
        if (!video || !(video.srcObject instanceof MediaStream)) return;
        const label = tile.querySelector(".tile-label");
        openSpotlight(video.srcObject, label ? label.textContent : "");
    });
});
