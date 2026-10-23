// SameSecond sync engine, shared by the web app and the extension.
// Edit this file in shared/ and run `npm run shared` to copy it into
// public/ and extension/.
(function (root) {
  "use strict";

  // Where the room says playback should be right now.
  function expectedPosition(state, serverNow) {
    if (!state) return 0;
    if (!state.playing) return state.position;
    return state.position + Math.max(0, serverNow - state.updatedAt) / 1000;
  }

  // Estimates the offset between this device's clock and the room server's.
  // Keeps the samples with the lowest round trip, since those are the most accurate.
  function ClockSync() {
    this.samples = [];
    this.offset = 0;
  }
  ClockSync.prototype.add = function (sentAt, serverTime, receivedAt) {
    var rtt = receivedAt - sentAt;
    this.samples.push({ rtt: rtt, offset: serverTime + rtt / 2 - receivedAt });
    this.samples.sort(function (a, b) { return a.rtt - b.rtt; });
    if (this.samples.length > 8) this.samples.length = 8;
    var best = this.samples.slice(0, 3);
    this.offset = best.reduce(function (s, x) { return s + x.offset; }, 0) / best.length;
    return this.offset;
  };
  ClockSync.prototype.now = function () { return Date.now() + this.offset; };

  // What kind of thing a URL points at.
  function classifyUrl(raw) {
    var u;
    try { u = new URL(raw); } catch (e) { return { kind: "invalid" }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "invalid" };
    var host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
    var id = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        var m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
        if (m) id = m[1];
      }
    }
    if (id && /^[\w-]{6,20}$/.test(id)) {
      var t = parseFloat(u.searchParams.get("t") || "0") || 0;
      return { kind: "youtube", id: id, start: t, pageUrl: "https://www.youtube.com/watch?v=" + id };
    }
    var ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    ext = ext ? ext.toLowerCase() : "";
    if (ext === "m3u8") return { kind: "file", url: u.href, hls: true };
    if (["mp4", "webm", "mov", "m4v", "ogv", "ogg", "mp3", "m4a", "mkv"].indexOf(ext) >= 0) return { kind: "file", url: u.href, hls: false };
    return { kind: "page", url: u.href, site: host };
  }

  // Two URLs count as the same video if they match on this key.
  function urlKey(raw) {
    var c = classifyUrl(raw);
    if (c.kind === "youtube") return "yt:" + c.id;
    try { var u = new URL(raw); return u.origin + u.pathname.replace(/\/$/, ""); } catch (e) { return raw; }
  }

  // Keeps one local player in step with the room.
  //
  // player: {
  //   getTime(): seconds, isPaused(): bool, play(), pause(), seek(seconds),
  //   setRate?(rate), getRate?(): number, isReady(): bool, isBlocked?(): bool (an advert is showing),
  //   isBuffering?(): bool, isLocked?(): bool (the browser refused to start playback
  //   until the viewer taps; the player then stays out of the room's way)
  //   seekThreshold?: seconds, supportsRate?: bool
  // }
  // send(message), now(): server-clock milliseconds
  // requireActivation: only broadcast local changes that follow a real user gesture
  function SyncController(opts) {
    this.player = opts.player;
    this.send = opts.send;
    this.now = opts.now;
    this.requireActivation = !!opts.requireActivation;
    this.canControl = opts.canControl || function () { return true; };
    this.onNotice = opts.onNotice || function () {};
    this.state = null;
    this.rate = 1;
    this.pending = null;
    this.ignoreUntil = 0;
    this.bufferSince = 0;
    this.bufferReported = false;
    this.stopped = false;
  }

  SyncController.prototype.applyRemote = function (state) {
    this.state = state;
    this.reconcile(true);
  };

  SyncController.prototype.setRate = function (r) {
    r = Math.round(r * 100) / 100;
    // Ask the player for its real speed: the site or the viewer may have changed it.
    var current = this.player.getRate ? Math.round(this.player.getRate() * 100) / 100 : this.rate;
    if (this.rate === r && current === r) return;
    this.rate = r;
    if (this.player.setRate && this.player.supportsRate !== false) {
      try { this.player.setRate(r); } catch (e) { /* some players refuse custom rates */ }
    }
  };

  SyncController.prototype.reconcile = function (force) {
    var p = this.player;
    if (this.stopped || !this.state || !p.isReady()) return;
    if (p.isBlocked && p.isBlocked()) return;
    if (p.isLocked && p.isLocked()) return;
    if (!force && Date.now() < this.ignoreUntil) return;
    var expected = expectedPosition(this.state, this.now());
    var local = p.getTime();
    var paused = p.isPaused();
    if (this.state.playing && paused) { this.mark("play"); p.play(); }
    if (!this.state.playing && !paused) { this.mark("pause"); p.pause(); }
    // Seeking while the player is still loading only makes the stall longer.
    if (this.state.playing && p.isBuffering && p.isBuffering()) return;
    var gap = expected - local;
    var abs = Math.abs(gap);
    var seekAt = p.seekThreshold || 0.5;
    if (!this.state.playing) {
      this.setRate(1);
      if (abs > 0.25) { this.mark(); p.seek(expected); }
      return;
    }
    if (abs > seekAt) {
      this.setRate(1);
      this.mark();
      p.seek(expected);
    } else if (abs > 0.06 && p.supportsRate !== false && p.setRate) {
      // Speed up or slow down in proportion to the gap (at most 10%), so a
      // typical slip closes within a few seconds without a visible jump.
      var nudge = Math.min(0.1, Math.max(0.02, Math.round(abs * 50) / 100));
      this.setRate(gap > 0 ? 1 + nudge : 1 - nudge);
    } else if (abs <= 0.03 || p.supportsRate === false || !p.setRate) {
      this.setRate(1);
    }
  };

  // Local changes the controller made itself fire player events too; ignore them
  // briefly. Only the matching event is ignored: if the controller paused the
  // player and the viewer then presses play, that play is the viewer's.
  SyncController.prototype.mark = function (command) {
    this.ignoreUntil = Date.now() + 900;
    if (command) this.lastCommand = { type: command, at: Date.now() };
  };

  // Call on the player's play, pause and seek events.
  SyncController.prototype.onLocalEvent = function (type) {
    var p = this.player;
    if (this.stopped || !this.state || !p.isReady()) return;
    if (p.isBlocked && p.isBlocked()) return;
    if (p.isLocked && p.isLocked()) return;
    var paused = p.isPaused();
    var local = p.getTime();
    var expected = expectedPosition(this.state, this.now());
    var moved = Math.abs(local - expected) > 1.2;
    // A seek only ever shares a new position. Whether the player is paused at
    // that moment says nothing about what the viewer wants.
    var differs = type === "seeked" ? moved : (paused === this.state.playing || moved);
    if (!differs) return;
    var cmd = this.lastCommand;
    if (cmd && cmd.type === type && Date.now() - cmd.at < 900) return;
    var userDidIt = !this.requireActivation ||
      !(typeof navigator !== "undefined" && navigator.userActivation) ||
      navigator.userActivation.isActive;
    if (!userDidIt) { this.reconcile(true); return; }
    if (!this.canControl()) {
      this.onNotice("Only the host can control playback in this room");
      this.reconcile(true);
      return;
    }
    // Apply locally at once so the next check does not pull us back, then send.
    var playing = type === "seeked" ? this.state.playing : !paused;
    this.state = { playing: playing, position: local, updatedAt: this.now(), url: this.state.url };
    var self = this;
    clearTimeout(this.pending);
    this.pending = setTimeout(function () {
      self.send({ t: "state", playing: self.state.playing, position: p.getTime(), at: self.now() });
    }, 150);
  };

  // Call about once a second.
  SyncController.prototype.tick = function () {
    var p = this.player;
    if (this.stopped || !p.isReady()) return;
    var locked = p.isLocked && p.isLocked();
    var buffering = !locked && ((p.isBuffering && p.isBuffering()) || (p.isBlocked && p.isBlocked()));
    if (buffering) {
      if (!this.bufferSince) this.bufferSince = Date.now();
      if (!this.bufferReported && Date.now() - this.bufferSince > 1000) {
        this.bufferReported = true;
        this.send({ t: "buffering", on: true });
      }
    } else {
      this.bufferSince = 0;
      if (this.bufferReported) { this.bufferReported = false; this.send({ t: "buffering", on: false }); }
    }
    this.reconcile(false);
  };

  SyncController.prototype.status = function () {
    var p = this.player;
    if (!p.isReady()) return { ready: false };
    return { ready: true, playing: !p.isPaused(), position: Math.round(p.getTime() * 10) / 10, buffering: this.bufferReported };
  };

  SyncController.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.pending);
    this.setRate(1);
    if (this.bufferReported) this.send({ t: "buffering", on: false });
  };

  function formatTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var mm = (h && m < 10 ? "0" : "") + m;
    return (h ? h + ":" : "") + mm + ":" + (r < 10 ? "0" : "") + r;
  }

  root.SyncCore = {
    expectedPosition: expectedPosition,
    ClockSync: ClockSync,
    classifyUrl: classifyUrl,
    urlKey: urlKey,
    SyncController: SyncController,
    formatTime: formatTime
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
