// Syncroom web app: landing page and the room (YouTube or direct-link
// playback, chat, people, voice). Works on phones and laptops.
(function () {
  "use strict";

  var SC = window.SyncCore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- small helpers ----------

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  };
  var session = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };

  function randomId(len) {
    var chars = "abcdefghijkmnpqrstuvwxyz23456789";
    var bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function clientKey() {
    var k = store.get("syncroom.clientKey");
    if (!k) { k = randomId(24); store.set("syncroom.clientKey", k); }
    return k;
  }

  function parseRoomCode(text) {
    text = String(text || "").trim().toLowerCase();
    var m = text.match(/\/r\/([a-z0-9]{6,16})/) || text.match(/^([a-z0-9]{6,16})$/);
    return m ? m[1] : null;
  }

  var toastTimer = null;
  function toast(text) {
    var el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "class") node.className = attrs[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }

  function extensionPresent() { return document.documentElement.dataset.syncroomExt; }

  function siteName(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return "a website"; }
  }

  // ---------- home ----------

  function initHome() {
    $("view-home").hidden = false;
    var name = $("start-name");
    name.value = store.get("syncroom.name") || "";

    $("start-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var url = $("start-url").value.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      var c = SC.classifyUrl(url);
      var hint = $("start-hint");
      if (c.kind === "invalid") {
        hint.textContent = "That doesn't look like a link. Paste the full address of the video.";
        hint.className = "hint bad";
        return;
      }
      if (c.kind === "page") {
        hint.textContent = "That's a page on " + c.site + ", not a video file. For sites like this, start the room from the browser extension while you're on the episode.";
        hint.className = "hint bad";
        return;
      }
      store.set("syncroom.name", name.value.trim());
      var id = randomId(8);
      session.set("syncroom.create." + id, JSON.stringify({ url: c.kind === "youtube" ? c.pageUrl : c.url, position: c.start || 0 }));
      location.href = "/r/" + id;
    });

    $("join-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var id = parseRoomCode($("join-code").value);
      if (id) location.href = "/r/" + id;
      else toast("That isn't a Syncroom invite link or code.");
    });

    setTimeout(function () {
      if (extensionPresent()) {
        $("ext-status").textContent = "Extension installed in this browser.";
        $("ext-status").className = "ext-status ok";
      }
    }, 1200);
  }

  // ---------- room ----------

  var R = null;

  function initRoom(id) {
    var params = new URLSearchParams(location.search);
    R = {
      id: id,
      kind: params.get("voice") === "1" ? "voice" : "web",
      name: store.get("syncroom.name") || "",
      ws: null,
      connected: false,
      everConnected: false,
      retry: 0,
      you: null,
      host: false,
      hostOnline: false,
      control: "everyone",
      members: [],
      state: null,
      title: "",
      clock: new SC.ClockSync(),
      adapter: null,
      controller: null,
      playerKey: null,
      pausedSince: 0,
      ended: false,
      timers: []
    };
    $("view-room").hidden = false;
    $("topbar-room").hidden = false;
    $("room-title").textContent = "Room " + id;
    document.title = "Room " + id + " · Syncroom";
    R.voice = new VoiceMesh(send);

    bindRoomUi();
    if (R.name) connect();
    else askName();
  }

  function askName() {
    var input = el("input", { id: "gate-name", maxlength: "32", placeholder: "Your name", autocomplete: "off" });
    var form = el("form", { class: "actions" }, [input, el("button", { class: "btn primary", type: "submit", text: "Join room" })]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      R.name = v;
      store.set("syncroom.name", v);
      connect();
    });
    stageCard([el("h2", { text: "You're invited to watch together" }), el("p", { text: "Pick a name so the others know who's here." }), form]);
    setTimeout(function () { input.focus(); }, 50);
  }

  function stageCard(children) {
    var stage = $("stage");
    destroyPlayer();
    stage.textContent = "";
    var card = el("div", { class: "stage-card" }, children);
    stage.appendChild(card);
    return card;
  }

  function wsUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/rooms/" + R.id + "/ws";
  }

  function send(msg) {
    if (R.ws && R.ws.readyState === 1) R.ws.send(JSON.stringify(msg));
  }

  function connect() {
    if (R.ended) return;
    if (!R.everConnected) stageCard([el("p", { text: "Connecting…" })]);
    var ws = new WebSocket(wsUrl());
    R.ws = ws;
    ws.onopen = function () {
      R.connected = true;
      R.retry = 0;
      var hello = { t: "hello", name: R.name, clientKey: clientKey(), kind: R.kind };
      var pending = session.get("syncroom.create." + R.id);
      if (pending) {
        try { hello.create = JSON.parse(pending); } catch (e) { /* ignore */ }
      }
      ws.send(JSON.stringify(hello));
      for (var i = 0; i < 5; i++) setTimeout(ping, i * 400);
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handle(msg);
    };
    ws.onclose = function (e) {
      R.connected = false;
      if (R.ws !== ws) return;
      if (e.code === 4004) { R.ended = true; return; }
      var wait = Math.min(10000, 1000 * Math.pow(2, R.retry++));
      setTimeout(connect, wait);
      updateSyncLine();
    };
  }

  function ping() { send({ t: "ping", c: Date.now() }); }

  function memberName(id) {
    var m = R.members.find(function (x) { return x.id === id; });
    return m ? m.name : "Someone";
  }

  function canControl() {
    return R.kind !== "voice" && (R.control === "everyone" || R.host || !R.hostOnline);
  }

  function handle(msg) {
    switch (msg.t) {
      case "pong":
        R.clock.add(msg.c, msg.s, Date.now());
        break;
      case "welcome":
        R.everConnected = true;
        session.del("syncroom.create." + R.id);
        if (!R.clock.samples.length) R.clock.offset = msg.serverTime - Date.now();
        R.you = msg.you;
        R.host = msg.host;
        R.control = msg.control;
        R.hostOnline = msg.hostOnline;
        R.members = msg.members;
        R.title = msg.title || "";
        renderChat(msg.chat);
        setState(msg.state, null, true);
        renderPeople();
        R.voice.rejoin();
        startTimers();
        break;
      case "state":
        setState(msg.state, msg.by, false);
        break;
      case "members":
        R.members = msg.members;
        R.control = msg.control;
        R.hostOnline = msg.hostOnline;
        renderPeople();
        R.voice.sync(R.members, R.you);
        break;
      case "chat":
        addChat(msg.message);
        break;
      case "signal":
        R.voice.onSignal(msg.from, msg.data);
        break;
      case "error":
        if (msg.code === "no-room") showEnded(msg.message);
        break;
    }
  }

  function showEnded(text) {
    R.ended = true;
    $("sync-line").hidden = true;
    $("change-form").hidden = true;
    stageCard([
      el("h2", { text: "This room isn't available" }),
      el("p", { text: text || "The room has ended or the link is wrong." }),
      el("a", { class: "btn primary", href: "/", text: "Start a new room" })
    ]);
  }

  function describeChange(prev, next, by) {
    if (!prev || !by || by === R.you) return;
    var who = memberName(by);
    if (SC.urlKey(prev.url) !== SC.urlKey(next.url)) return toast(who + " started a new video");
    if (prev.intendsToPlay !== next.intendsToPlay) return toast(who + (next.intendsToPlay ? " pressed play" : " paused"));
    var prevAt = SC.expectedPosition(prev, R.clock.now());
    if (Math.abs(prevAt - next.position) > 3) toast(who + " jumped to " + SC.formatTime(next.position));
  }

  function setState(state, by, initial) {
    var prev = R.state;
    R.state = state;
    if (!initial) describeChange(prev, state, by);
    var key = SC.urlKey(state.url);
    if (key !== R.playerKey) setupPlayer(state);
    else if (R.controller) R.controller.applyRemote(state);
    updateSyncLine();
  }

  // ---------- players ----------

  function destroyPlayer() {
    if (R && R.controller) R.controller.stop();
    if (R && R.adapter && R.adapter.destroy) R.adapter.destroy();
    if (R) { R.controller = null; R.adapter = null; R.playerKey = null; }
  }

  function setupPlayer(state) {
    destroyPlayer();
    var c = SC.classifyUrl(state.url);
    R.playerKey = SC.urlKey(state.url);
    $("sync-line").hidden = false;
    $("change-form").hidden = !canControl() || R.kind === "voice";
    setTitle(R.title || (c.kind === "page" ? c.site : c.kind === "file" ? decodeURIComponent(c.url.split("/").pop()) : "YouTube"));

    if (R.kind === "voice") return showVoiceCard();
    if (c.kind === "page" || c.kind === "invalid") return showPageCard(state.url);

    var stage = $("stage");
    stage.textContent = "";
    var onEvent = function (type) { if (R.controller) R.controller.onLocalEvent(type); };
    R.adapter = c.kind === "youtube" ? youTubePlayer(stage, c.id, onEvent) : filePlayer(stage, c, onEvent);
    R.controller = new SC.SyncController({
      player: R.adapter,
      send: send,
      now: function () { return R.clock.now(); },
      canControl: canControl,
      onNotice: toast
    });
    R.adapter.onReady = function () {
      if (c.kind === "youtube" && R.adapter.title()) setTitle(R.title || R.adapter.title());
      R.controller.applyRemote(R.state);
    };
  }

  function setTitle(t) {
    $("room-title").textContent = t;
    document.title = t + " · Syncroom";
  }

  function showPageCard(url) {
    var site = siteName(url);
    var actions = el("div", { class: "actions" });
    var ext = extensionPresent();
    if (ext) {
      actions.appendChild(el("button", {
        class: "btn primary", type: "button", text: "Open in the extension",
        onclick: function () {
          window.postMessage({ source: "syncroom-page", type: "join", roomId: R.id, name: R.name }, location.origin);
          toast("Opening " + site + " in a new tab");
        }
      }));
    } else {
      actions.appendChild(el("a", { class: "btn primary", href: "/extension.html", text: "Get the extension" }));
    }
    stageCard([
      el("span", { class: "site", text: site }),
      el("h2", { text: R.title || "Watching on " + site }),
      el("p", { text: ext
        ? "This video plays inside " + site + ". The extension opens it in a new tab and keeps it in sync. You'll need to be signed in to your own account."
        : "This video plays inside " + site + ", so it needs the Syncroom extension on a laptop or PC, signed in to your own account. On this device you can still chat and join voice." }),
      actions
    ]);
  }

  function showVoiceCard() {
    stageCard([
      el("h2", { text: "Voice chat" }),
      el("p", { text: "Keep this window open to talk while you watch. Your video plays in the other tab." }),
      el("div", { class: "actions" }, [el("button", { class: "btn primary", type: "button", text: R.voice.on ? "Leave voice" : "Join voice", onclick: function () { toggleVoice(); showVoiceCard(); } })])
    ]);
  }

  var ytApi = null;
  function loadYouTubeApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise(function (resolve) {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      window.onYouTubeIframeAPIReady = function () { resolve(window.YT); };
      var s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
    return ytApi;
  }

  function youTubePlayer(stage, videoId, onEvent) {
    var holder = el("div", { class: "yt" });
    stage.appendChild(holder);
    var player = null, ready = false, ytState = -1, destroyed = false;
    var lastTime = 0, lastAt = 0, poll = null, everPlayed = false, playAskedAt = 0;
    var a = {
      supportsRate: true,
      // YouTube seeks rebuffer briefly, so small drift is fixed by speed instead.
      seekThreshold: 0.8,
      onReady: null,
      isReady: function () { return ready; },
      getTime: function () { return player.getCurrentTime() || 0; },
      isPaused: function () { return !(ytState === 1 || ytState === 3); },
      isBuffering: function () { return ytState === 3; },
      // Phones keep YouTube from starting until the viewer taps the video once.
      isLocked: function () { return !everPlayed && playAskedAt > 0 && Date.now() - playAskedAt > 2000 && ytState !== 1 && ytState !== 3; },
      unlock: function () { playAskedAt = Date.now(); },
      play: function () { if (!playAskedAt) playAskedAt = Date.now(); player.playVideo(); },
      pause: function () { player.pauseVideo(); },
      seek: function (t) { player.seekTo(t, true); lastTime = t; lastAt = Date.now(); },
      setRate: function (r) { player.setPlaybackRate(r); },
      title: function () { try { return player.getVideoData().title; } catch (e) { return ""; } },
      destroy: function () { destroyed = true; clearInterval(poll); try { player && player.destroy(); } catch (e) { /* gone */ } }
    };
    loadYouTubeApi().then(function (YT) {
      if (destroyed) return;
      player = new YT.Player(holder, {
        videoId: videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: function () {
            ready = true;
            lastTime = a.getTime(); lastAt = Date.now();
            // The iframe API has no seek event, so watch for jumps in the clock.
            poll = setInterval(function () {
              if (!ready) return;
              var t = a.getTime(), now = Date.now();
              var rate = player.getPlaybackRate ? player.getPlaybackRate() || 1 : 1;
              var predicted = lastTime + (ytState === 1 ? rate * (now - lastAt) / 1000 : 0);
              if (Math.abs(t - predicted) > 1.5) onEvent("seeked");
              lastTime = t; lastAt = now;
            }, 500);
            if (a.onReady) a.onReady();
          },
          onStateChange: function (e) {
            var prev = ytState;
            ytState = e.data;
            if (e.data === 1) { everPlayed = true; hideUnlock(); onEvent("play"); }
            // Only a pause after real playback is the viewer's choice.
            else if (e.data === 2 && (prev === 1 || prev === 3) && everPlayed) onEvent("pause");
          }
        }
      });
    });
    return a;
  }

  var hlsLib = null;
  function loadHls() {
    if (hlsLib) return hlsLib;
    hlsLib = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
      s.onload = function () { resolve(window.Hls); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return hlsLib;
  }

  function filePlayer(stage, c, onEvent) {
    var video = el("video", { controls: "", playsinline: "", preload: "auto" });
    stage.appendChild(video);
    var hls = null, waiting = false, locked = false;
    var a = {
      supportsRate: true,
      seekThreshold: 0.5,
      onReady: null,
      video: video,
      isReady: function () { return video.readyState >= 1; },
      getTime: function () { return video.currentTime; },
      isPaused: function () { return video.paused; },
      isBuffering: function () { return waiting && !video.paused && video.readyState < 3; },
      isLocked: function () { return locked; },
      unlock: function () { locked = false; },
      play: function () {
        var p = video.play();
        if (p && p.catch) p.catch(function (e) {
          if (e && e.name === "NotAllowedError") { locked = true; showUnlock(); }
        });
      },
      pause: function () { video.pause(); },
      seek: function (t) { video.currentTime = t; },
      setRate: function (r) { video.playbackRate = r; },
      destroy: function () { if (hls) hls.destroy(); video.removeAttribute("src"); video.load(); }
    };
    video.addEventListener("loadedmetadata", function () { if (a.onReady) a.onReady(); }, { once: true });
    ["play", "pause", "seeked"].forEach(function (t) { video.addEventListener(t, function () { onEvent(t); }); });
    video.addEventListener("waiting", function () { waiting = true; });
    video.addEventListener("playing", function () { waiting = false; locked = false; hideUnlock(); });
    video.addEventListener("canplay", function () { waiting = false; });
    video.addEventListener("error", function () {
      stage.appendChild(el("div", { class: "stage-card" }, [el("h2", { text: "This video won't load" }), el("p", { text: "The link may have expired, or the site blocks playing its videos elsewhere." })]));
    });

    var nativeHls = video.canPlayType("application/vnd.apple.mpegurl");
    if (c.hls && !nativeHls) {
      loadHls().then(function (Hls) {
        if (!Hls.isSupported()) throw new Error("hls unsupported");
        hls = new Hls();
        hls.loadSource(c.url);
        hls.attachMedia(video);
      }).catch(function () { toast("This browser can't play that stream."); });
    } else {
      video.src = c.url;
    }
    return a;
  }

  function showUnlock() {
    $("unlock").hidden = false;
  }
  function hideUnlock() {
    $("unlock").hidden = true;
    R.pausedSince = 0;
  }

  // ---------- timers and status ----------

  function startTimers() {
    if (R.timers.length) return;
    R.timers.push(setInterval(function () {
      if (R.controller) R.controller.tick();
      watchAutoplay();
      updateSyncLine();
    }, 1000));
    R.timers.push(setInterval(function () {
      if (R.controller) {
        var s = R.controller.status();
        send({ t: "status", ready: s.ready, playing: s.playing, position: s.position, buffering: s.buffering });
      }
    }, 5000));
    R.timers.push(setInterval(ping, 30000));
    R.timers.push(setInterval(function () { send({ t: "hb" }); }, 25000));
  }

  // Phones often refuse to start playback until someone taps.
  function watchAutoplay() {
    var a = R.adapter;
    if (!a || !a.isReady() || !R.state) return;
    if (a.isLocked && a.isLocked()) return showUnlock();
    if (R.state.playing && a.isPaused() && !(a.isBuffering && a.isBuffering())) {
      if (!R.pausedSince) R.pausedSince = Date.now();
      if (Date.now() - R.pausedSince > 2500) showUnlock();
    } else {
      hideUnlock();
    }
  }

  function updateSyncLine() {
    var dot = $("sync-dot"), text = $("sync-text");
    var set = function (cls, t) { dot.className = "sync-dot " + cls; text.textContent = t; };
    if (!R.state) return;
    if (!R.connected) return set("bad", "Reconnecting…");
    var c = SC.classifyUrl(R.state.url);
    if (R.kind === "voice") return set("ok", "Connected to the room");
    if (c.kind === "page") return set("ok", "This room is watching on " + c.site);
    if (R.state.waitingFor && R.state.waitingFor.length) return set("wait", "Waiting for " + R.state.waitingFor.join(", ") + " to load");
    var a = R.adapter;
    if (!a || !a.isReady()) return set("wait", "Loading video");
    if (a.isLocked && a.isLocked()) return set("wait", "Tap to start watching with everyone");
    var expected = SC.expectedPosition(R.state, R.clock.now());
    if (!R.state.playing) return set("ok", "Paused at " + SC.formatTime(expected));
    var gap = Math.abs(expected - a.getTime());
    if (gap < 0.8) set("ok", "In sync");
    else set("wait", "Catching up (" + gap.toFixed(1) + " s)");
  }

  // ---------- chat ----------

  function renderChat(list) {
    var log = $("chat-log");
    log.textContent = "";
    if (!list || !list.length) {
      log.appendChild(el("p", { class: "chat-empty", id: "chat-empty", text: "No messages yet. Share the invite link and say hi." }));
      return;
    }
    list.forEach(addChat);
  }

  function addChat(m) {
    var log = $("chat-log");
    var empty = $("chat-empty");
    if (empty) empty.remove();
    var time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.appendChild(el("div", { class: "msg" }, [
      el("span", { class: "who" }, [m.name, el("time", { text: time })]),
      el("span", { text: m.text })
    ]));
    if (nearBottom) log.scrollTop = log.scrollHeight;
    if ($("panel-chat").hidden && m.from !== R.you) toast(m.name + ": " + m.text);
  }

  // ---------- people ----------

  function describeStatus(m) {
    if (m.kind === "voice") return "Voice only";
    if (!m.status || !m.status.ready) return m.kind === "ext" ? "Extension · loading" : "Chat only";
    var where = m.kind === "ext" ? "Extension" : "Web";
    if (m.status.buffering) return where + " · loading";
    return where + " · " + (m.status.playing ? "playing " : "paused ") + SC.formatTime(m.status.position);
  }

  function renderPeople() {
    var list = $("people");
    list.textContent = "";
    var watchers = R.members.filter(function (m) { return m.kind !== "voice"; });
    $("people-count").textContent = String(watchers.length);
    R.members.forEach(function (m) {
      var badges = el("div", { class: "badges" });
      if (m.host) badges.appendChild(el("span", { class: "badge host", text: "host" }));
      if (m.voice) badges.appendChild(el("span", { class: "badge voice", text: "voice" }));
      list.appendChild(el("li", null, [
        el("div", { class: "person" }, [
          el("span", { class: "name", text: m.name + (m.id === R.you ? " (you)" : "") }),
          el("span", { class: "meta", text: describeStatus(m) })
        ]),
        badges
      ]));
    });
    $("control-setting").hidden = !R.host;
    $("control-select").value = R.control;
    $("change-form").hidden = !canControl() || R.kind === "voice" || !R.state;
    renderVoicePeople();
  }

  function renderVoicePeople() {
    var talking = R.members.filter(function (m) { return m.voice; }).map(function (m) {
      if (!R.voice.on || m.id === R.you) return m.name;
      var p = R.voice.peers.get(m.id);
      var st = p ? p.pc.connectionState : "new";
      if (st === "connected") return m.name;
      if (st === "failed") return m.name + " (can't connect)";
      return m.name + " (connecting…)";
    });
    var el = $("voice-people");
    el.textContent = talking.length ? talking.join(", ") : "Nobody is talking yet";
  }

  // ---------- room UI wiring ----------

  function bindRoomUi() {
    $("tab-chat").addEventListener("click", function () { showTab("chat"); });
    $("tab-people").addEventListener("click", function () { showTab("people"); });

    $("chat-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("chat-input");
      var text = input.value.trim();
      if (!text) return;
      if (!R.connected) return toast("Not connected. Your message wasn't sent.");
      send({ t: "chat", text: text });
      input.value = "";
    });

    $("copy-invite").addEventListener("click", function () {
      var link = location.origin + "/r/" + R.id;
      var touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (touch && navigator.share) {
        navigator.share({ title: "Watch with me on Syncroom", url: link }).catch(function () { /* dismissed */ });
        return;
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(function () { toast("Invite link copied"); }, function () { toast(link); });
      } else {
        toast(link);
      }
    });

    $("control-select").addEventListener("change", function (e) {
      send({ t: "settings", control: e.target.value });
    });

    $("change-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("change-url");
      var url = input.value.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      var c = SC.classifyUrl(url);
      if (c.kind === "invalid") return toast("That doesn't look like a link.");
      if (c.kind === "page") return toast("That's a web page, not a video. Use the extension for sites like " + c.site + ".");
      send({ t: "navigate", url: c.kind === "youtube" ? c.pageUrl : c.url, position: c.start || 0, playing: false, title: "" });
      input.value = "";
    });

    $("unlock-btn").addEventListener("click", function () {
      var a = R.adapter;
      if (!a) return;
      if (a.unlock) a.unlock();
      a.play();
      setTimeout(function () { if (R.controller) R.controller.reconcile(true); }, 300);
      $("unlock-text").textContent = "If it's still paused, tap play on the video itself.";
    });

    $("voice-toggle").addEventListener("click", toggleVoice);
    $("voice-mute").addEventListener("click", function () {
      var muted = R.voice.toggleMute();
      $("voice-mute").textContent = muted ? "Unmute" : "Mute";
    });
  }

  function showTab(which) {
    var chat = which === "chat";
    $("tab-chat").setAttribute("aria-selected", String(chat));
    $("tab-people").setAttribute("aria-selected", String(!chat));
    $("panel-chat").hidden = !chat;
    $("panel-people").hidden = chat;
  }

  function toggleVoice() {
    var btn = $("voice-toggle");
    if (R.voice.on) {
      R.voice.leave();
      btn.textContent = "Join voice";
      btn.classList.add("primary");
      $("voice-mute").hidden = true;
      return;
    }
    btn.disabled = true;
    R.voice.join().then(function () {
      btn.textContent = "Leave voice";
      btn.classList.remove("primary");
      $("voice-mute").hidden = false;
      $("voice-mute").textContent = "Mute";
    }, function (err) {
      toast(err && err.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser's site settings." : "Couldn't start the microphone.");
    }).then(function () { btn.disabled = false; });
  }

  // ---------- voice: one direct audio connection per pair of people ----------

  function VoiceMesh(sendFn) {
    this.send = sendFn;
    this.peers = new Map();
    this.stream = null;
    this.on = false;
    this.muted = false;
    this.iceServers = null;
  }

  VoiceMesh.prototype.join = function () {
    var self = this;
    var ice = this.iceServers ? Promise.resolve(this.iceServers) : fetch("/api/ice").then(function (r) { return r.json(); }).then(function (d) {
      self.iceServers = d.iceServers;
      return d.iceServers;
    }).catch(function () { return [{ urls: "stun:stun.l.google.com:19302" }]; });
    return ice.then(function () {
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }).then(function (stream) {
      self.stream = stream;
      self.on = true;
      self.muted = false;
      self.send({ t: "voice", on: true });
      self.sync(R.members, R.you);
    });
  };

  // After a reconnect the server has forgotten we were in voice.
  VoiceMesh.prototype.rejoin = function () {
    if (!this.on) return;
    this.peers.forEach(function (p) { p.pc.close(); if (p.audio) p.audio.remove(); });
    this.peers.clear();
    this.send({ t: "voice", on: true });
  };

  VoiceMesh.prototype.leave = function () {
    this.on = false;
    this.peers.forEach(function (p) { p.pc.close(); if (p.audio) p.audio.remove(); });
    this.peers.clear();
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    this.send({ t: "voice", on: false });
  };

  VoiceMesh.prototype.toggleMute = function () {
    this.muted = !this.muted;
    var muted = this.muted;
    if (this.stream) this.stream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    return muted;
  };

  VoiceMesh.prototype.sync = function (members, you) {
    if (!this.on) return;
    var self = this;
    var others = members.filter(function (m) { return m.voice && m.id !== you; });
    var ids = new Set(others.map(function (m) { return m.id; }));
    this.peers.forEach(function (p, id) {
      if (!ids.has(id)) { p.pc.close(); if (p.audio) p.audio.remove(); self.peers.delete(id); }
    });
    // The person with the smaller id starts each connection, so exactly one side offers.
    others.forEach(function (m) {
      if (!self.peers.has(m.id) && you < m.id) self.peer(m.id, true);
    });
  };

  VoiceMesh.prototype.peer = function (id, initiator) {
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: this.iceServers || [] });
    var entry = { pc: pc, audio: null, queued: [] };
    this.peers.set(id, entry);
    this.stream.getTracks().forEach(function (t) { pc.addTrack(t, self.stream); });
    pc.onicecandidate = function (e) { if (e.candidate) self.send({ t: "signal", to: id, data: { ice: e.candidate } }); };
    pc.ontrack = function (e) {
      if (!entry.audio) {
        entry.audio = el("audio", { autoplay: "", playsinline: "" });
        entry.audio.hidden = true;
        document.body.appendChild(entry.audio);
      }
      entry.audio.srcObject = e.streams[0];
      var p = entry.audio.play();
      if (p && p.catch) p.catch(function () { /* starts on next tap */ });
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed") toast("Voice couldn't connect to " + memberName(id) + ". Their network may block direct calls.");
      renderVoicePeople();
    };
    if (initiator) {
      pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
        self.send({ t: "signal", to: id, data: { sdp: pc.localDescription } });
      });
    }
    return entry;
  };

  VoiceMesh.prototype.onSignal = function (from, data) {
    if (!this.on || !data) return;
    var self = this;
    var entry = this.peers.get(from) || this.peer(from, false);
    var pc = entry.pc;
    if (data.sdp) {
      pc.setRemoteDescription(data.sdp).then(function () {
        entry.queued.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
        if (data.sdp.type === "offer") {
          return pc.createAnswer().then(function (ans) { return pc.setLocalDescription(ans); }).then(function () {
            self.send({ t: "signal", to: from, data: { sdp: pc.localDescription } });
          });
        }
      }).catch(function () { /* stale offer */ });
    } else if (data.ice) {
      if (pc.remoteDescription) pc.addIceCandidate(data.ice).catch(function () {});
      else entry.queued.push(data.ice);
    }
  };

  // ---------- start ----------

  var roomMatch = location.pathname.match(/^\/r\/([a-z0-9]{6,16})\/?$/);
  if (roomMatch) initRoom(roomMatch[1]);
  else initHome();
})();
