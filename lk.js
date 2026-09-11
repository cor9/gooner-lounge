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
