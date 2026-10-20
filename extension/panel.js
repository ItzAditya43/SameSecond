// Syncroom panel: start or join a room, invite link, people, chat.
(function () {
  "use strict";
  var api = globalThis.browser || globalThis.chrome;
  var SC = globalThis.SyncCore;
  var $ = function (id) { return document.getElementById(id); };
  var snap = null;
  var port = null;
  var chatCount = -1;

  function connect() {
    port = api.runtime.connect({ name: "syncroom-panel" });
    port.onMessage.addListener(function (msg) {
      if (msg.type === "snapshot") render(msg);
    });
    port.onDisconnect.addListener(function () { setTimeout(connect, 500); });
  }

  function post(msg) {
    try { port.postMessage(msg); } catch (e) { connect(); port.postMessage(msg); }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function site(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function activeTab() {
    return api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) { return tabs[0]; });
  }

  // Firefox asks for website access separately from installing.
  function checkPermission() {
    if (!api.permissions || !api.permissions.contains) return;
    api.permissions.contains({ origins: ["<all_urls>"] }).then(function (ok) { $("perm").hidden = ok; });
  }

  function render(s) {
    var first = !snap;
    snap = s;
    $("error").hidden = !s.error;
    $("error-text").textContent = s.error || "";
    $("lobby").hidden = s.inRoom;
    $("room").hidden = !s.inRoom;
    var conn = $("conn");
    conn.hidden = !s.inRoom;
    conn.textContent = s.connected ? "Connected" : "Reconnecting…";
    conn.className = "conn" + (s.connected ? "" : " bad");

    if (first || document.activeElement !== $("name")) $("name").value = s.settings.name || "";
    if (first || document.activeElement !== $("server")) $("server").value = s.settings.serverUrl || "";
    if (!s.inRoom) { chatCount = -1; updateTabInfo(); return; }

    var url = s.state ? s.state.url : "";
    $("room-site").textContent = site(url);
    $("room-title").textContent = s.title || site(url) || "Room " + s.roomId;
    $("invite").value = s.inviteUrl;
    renderSync(s);
    renderPeople(s);
    renderChat(s);
  }

  function renderSync(s) {
    var dot = $("sync-dot"), text = $("sync-text");
    var set = function (cls, t) { dot.className = "dot " + cls; text.textContent = t; };
    if (!s.connected) return set("bad", "Not connected to the room");
    if (!s.state) return set("wait", "Joining…");
    if (!s.videoFound) return set("wait", "Looking for the video on the page");
    if (s.state.waitingFor.length) return set("wait", "Waiting for " + s.state.waitingFor.join(", "));
    var at = SC.formatTime(SC.expectedPosition(s.state, s.serverNow));
    set("ok", (s.state.playing ? "Playing together · " : "Paused · ") + at);
  }

  function renderPeople(s) {
    var list = $("people");
    list.textContent = "";
    var watchers = s.members.filter(function (m) { return m.kind !== "voice"; });
    $("count").textContent = String(watchers.length);
    s.members.forEach(function (m) {
      var li = el("li");
      var who = el("div");
      who.appendChild(el("span", null, m.name + (m.id === s.you ? " (you)" : "")));
      var meta = m.kind === "voice" ? "Voice" : m.kind === "web" ? "Web" : "Extension";
      if (m.status && m.status.ready) meta += " · " + (m.status.buffering ? "loading" : (m.status.playing ? "playing " : "paused ") + SC.formatTime(m.status.position));
      if (m.voice) meta += " · in voice";
      who.appendChild(el("span", "meta", meta));
      li.appendChild(who);
      if (m.host) li.appendChild(el("span", "badge host", "host"));
      list.appendChild(li);
    });
    $("control-box").hidden = !s.host;
    $("control").value = s.control;
  }

  function renderChat(s) {
    if (s.chat.length === chatCount) return;
    chatCount = s.chat.length;
    var log = $("log");
    log.textContent = "";
    if (!s.chat.length) log.appendChild(el("p", "empty", "No messages yet."));
    s.chat.forEach(function (m) {
      var row = el("div", "msg");
      row.appendChild(el("b", null, m.name));
      row.appendChild(el("time", null, new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
      row.appendChild(el("div", null, m.text));
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;
  }

  function updateTabInfo() {
    activeTab().then(function (tab) {
      var ok = tab && /^https?:/.test(tab.url || "");
      $("start").disabled = !ok;
      $("tab-info").textContent = ok
        ? "This tab: " + (tab.title || site(tab.url))
        : "Open the episode or video you want to watch, then start the room here.";
    }).catch(function () {});
  }

  function name() { return $("name").value.trim(); }

  $("start").addEventListener("click", function () {
    if (!name()) { $("name").focus(); return; }
    activeTab().then(function (tab) { post({ type: "start", tabId: tab.id, name: name() }); });
  });
  $("join-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!name()) { $("name").focus(); return; }
    post({ type: "join", code: $("code").value, name: name() });
    $("code").value = "";
  });
  $("name").addEventListener("change", function () { if (name()) post({ type: "settings", settings: { name: name() } }); });
  $("save-server").addEventListener("click", function () {
    post({ type: "settings", settings: { serverUrl: $("server").value.trim() } });
  });
  $("copy").addEventListener("click", function () {
    var input = $("invite");
    var done = function () { $("copy").textContent = "Copied"; setTimeout(function () { $("copy").textContent = "Copy"; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
    else input.select();
  });
  $("focus").addEventListener("click", function () { post({ type: "focus" }); });
  $("voice").addEventListener("click", function () { post({ type: "voice" }); });
  $("leave").addEventListener("click", function () { post({ type: "leave" }); });
  $("control").addEventListener("change", function (e) { post({ type: "control", control: e.target.value }); });
  $("chat-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = $("chat").value.trim();
    if (!t) return;
    post({ type: "chat", text: t });
    $("chat").value = "";
  });
  $("error-dismiss").addEventListener("click", function () { post({ type: "dismiss" }); });
  $("perm-btn").addEventListener("click", function () {
    api.permissions.request({ origins: ["<all_urls>"] }).then(checkPermission);
  });

  if (api.tabs.onActivated) api.tabs.onActivated.addListener(function () { if (snap && !snap.inRoom) updateTabInfo(); });
  if (api.tabs.onUpdated) api.tabs.onUpdated.addListener(function () { if (snap && !snap.inRoom) updateTabInfo(); });
  // Keep the playback clock in the panel moving between updates.
  setInterval(function () { if (snap && snap.inRoom) { snap.serverNow += 1000; renderSync(snap); } }, 1000);

  checkPermission();
  connect();
})();
