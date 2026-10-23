// Syncroom sync script. Runs in every frame of the room's tab; the frame
// holding the largest video becomes the active one and keeps it in sync.
(function () {
  "use strict";
  if (window.__syncroomLoaded) return;
  window.__syncroomLoaded = true;

  var api = globalThis.browser || globalThis.chrome;
  var SC = globalThis.SyncCore;
  var host = location.hostname;
  var isNetflix = /(^|\.)netflix\.com$/.test(host);
  var isYouTube = /(^|\.)youtube\.com$/.test(host);

  var port = null;
  var dead = false;
  var active = false;
  var video = null;
  var adapter = null;
  var controller = null;
  var offset = 0;
  var allowed = true;
  var lastArea = -1;
  var lastReadyKey = "";
  var timers = [];

  function post(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (e) { port = null; }
  }

  function connect() {
    if (dead) return;
    try {
      port = api.runtime.connect({ name: "syncroom-frame" });
    } catch (e) {
      // The extension was reloaded or removed; this copy of the script is orphaned.
      shutdown();
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(function () {
      port = null;
      lastArea = -1;
      if (!dead) setTimeout(connect, 1000);
    });
    scan(true);
  }

  // ---------- players ----------

  function largestVideo() {
    var best = null, bestArea = 0;
    var list = document.querySelectorAll("video");
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { best = list[i]; bestArea = area; }
    }
    return { video: best, area: Math.round(bestArea) };
  }

  function netflix(cmd, extra) {
    var msg = { __syncroom: "nf", cmd: cmd };
    for (var k in extra) msg[k] = extra[k];
    window.postMessage(msg, location.origin);
  }

  function makeAdapter(v) {
    var waiting = false, locked = false;
    var a = {
      supportsRate: !isNetflix,
      // Netflix seeks are slow, so allow a bit more drift before jumping.
      seekThreshold: isNetflix ? 1.0 : 0.5,
      isReady: function () { return v.readyState >= 1 && isFinite(v.duration || 0); },
      getTime: function () { return v.currentTime; },
      isPaused: function () { return v.paused; },
      isBuffering: function () { return waiting && !v.paused && v.readyState < 3; },
      isBlocked: function () {
        return isYouTube && !!document.querySelector(".html5-video-player.ad-showing");
      },
      isLocked: function () { return locked; },
      play: function () {
        if (isNetflix) return netflix("play");
        var p = v.play();
        if (p && p.catch) p.catch(function (e) {
          if (e && e.name === "NotAllowedError") { locked = true; toast("Tap play once to join the room's playback"); }
        });
      },
      pause: function () { if (isNetflix) netflix("pause"); else v.pause(); },
      seek: function (t) {
        // Setting currentTime directly crashes Netflix's player, so ask the page instead.
        if (isNetflix) netflix("seek", { ms: Math.round(t * 1000) });
        else v.currentTime = t;
      },
      setRate: function (r) { v.playbackRate = r; },
      getRate: function () { return v.playbackRate; }
    };
    var handlers = {
      play: function () { if (controller) controller.onLocalEvent("play"); },
      pause: function () { if (controller) controller.onLocalEvent("pause"); },
      seeked: function () { if (controller) controller.onLocalEvent("seeked"); },
      waiting: function () { waiting = true; },
      playing: function () { waiting = false; locked = false; },
      canplay: function () { waiting = false; },
      loadedmetadata: function () { reportReady(); }
    };
    Object.keys(handlers).forEach(function (k) { v.addEventListener(k, handlers[k]); });
    a.destroy = function () {
      Object.keys(handlers).forEach(function (k) { v.removeEventListener(k, handlers[k]); });
    };
    return a;
  }

  function bindVideo(v) {
    if (v === video) return;
    stopController();
    if (adapter) adapter.destroy();
    video = v;
    adapter = v ? makeAdapter(v) : null;
    lastReadyKey = "";
    if (active && adapter) startController(null);
  }

  // ---------- syncing ----------

  function startController(state) {
    stopController();
    if (!adapter) return;
    controller = new SC.SyncController({
      player: adapter,
      send: function (m) { post({ type: "send", msg: m }); },
      now: function () { return Date.now() + offset; },
      requireActivation: true,
      canControl: function () { return allowed; },
      onNotice: toast
    });
    if (state) controller.applyRemote(state);
    reportReady();
  }

  function stopController() {
    if (controller) controller.stop();
    controller = null;
  }

  // Tell the background a video is loaded, so a new episode can move the room.
  function reportReady() {
    if (!active || !video || !adapter || !adapter.isReady()) return;
    var key = (video.currentSrc || "") + "|" + Math.round(video.duration || 0) + "|" + location.href;
    if (key === lastReadyKey) return;
    lastReadyKey = key;
    post({ type: "ready", duration: video.duration, position: video.currentTime, playing: !video.paused, at: Date.now() + offset });
  }

  function scan(force) {
    var found = largestVideo();
    bindVideo(found.video);
    if (force || Math.abs(found.area - lastArea) > 1000 || (found.area === 0) !== (lastArea === 0)) {
      lastArea = found.area;
      post({ type: "video", area: found.area });
    }
    reportReady();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "activate":
        active = !!msg.on;
        if (typeof msg.offset === "number") offset = msg.offset;
        if (typeof msg.canControl === "boolean") allowed = msg.canControl;
        if (active) startController(msg.state);
        else stopController();
        break;
      case "state":
        if (typeof msg.offset === "number") offset = msg.offset;
        if (!active) break;
        if (!controller) startController(msg.state);
        else controller.applyRemote(msg.state);
        break;
      case "clock":
        offset = msg.offset;
        break;
      case "perm":
        allowed = !!msg.canControl;
        break;
      case "toast":
        if (active) toast(msg.text);
        break;
      case "detach":
        shutdown();
        break;
    }
  }

  function shutdown() {
    dead = true;
    stopController();
    if (adapter) adapter.destroy();
    adapter = null;
    video = null;
    timers.forEach(clearInterval);
    if (port) { try { port.disconnect(); } catch (e) { /* gone */ } }
    port = null;
    window.__syncroomLoaded = false;
  }

  // ---------- on-video notices ----------

  var toastHost = null, toastText = null, toastTimer = null;
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      var shadow = toastHost.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = ".t{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);max-width:min(480px,90vw);" +
        "background:rgba(12,16,24,.92);color:#e9edf5;font:500 14px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:8px;" +
        "border-left:3px solid #4fd1c5;z-index:2147483647;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4)}";
      toastText = document.createElement("div");
      toastText.className = "t";
      shadow.appendChild(style);
      shadow.appendChild(toastText);
    }
    // In fullscreen only the fullscreen element is visible, so show the notice inside it.
    var parent = document.fullscreenElement || document.body || document.documentElement;
    if (parent.tagName === "VIDEO") parent = document.body;
    if (toastHost.parentNode !== parent) parent.appendChild(toastHost);
    toastText.textContent = text;
    toastHost.style.display = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastHost.style.display = "none"; }, 3500);
  }

  // ---------- loop ----------

  timers.push(setInterval(function () {
    scan(false);
    if (controller) controller.tick();
    // Keep the hint up until the viewer taps play (phones block autoplay).
    if (active && adapter && adapter.isLocked && adapter.isLocked()) toast("Tap play once to join the room's playback");
  }, 1000));
  timers.push(setInterval(function () {
    if (active && controller) {
      var s = controller.status();
      post({ type: "send", msg: { t: "status", ready: s.ready, playing: s.playing, position: s.position, buffering: s.buffering } });
    }
  }, 10000));

  connect();
})();
