// Syncroom background: holds the connection to the room server, injects the
// sync script into the room's tab, and relays messages between the tab, the
// panel and the room.
/* global importScripts */
if (typeof importScripts === "function" && !globalThis.SyncCore) importScripts("config.js", "sync-core.js");

const api = globalThis.browser || globalThis.chrome;
const SC = globalThis.SyncCore;

const S = {
  settings: { serverUrl: globalThis.SYNCROOM_DEFAULT_SERVER, name: "", clientKey: "" },
  roomId: null,
  tabId: null,
  ws: null,
  connected: false,
  retry: 0,
  you: null,
  host: false,
  hostOnline: false,
  control: "everyone",
  members: [],
  state: null,
  title: "",
  chat: [],
  error: "",
  clock: new SC.ClockSync(),
  frames: new Map(),
  activeFrame: null,
  panels: new Set(),
  followUntil: 0,
  timers: []
};

const ready = init();

async function init() {
  const saved = await api.storage.local.get(["settings", "session"]);
  if (saved.settings) Object.assign(S.settings, saved.settings);
  if (!S.settings.clientKey) {
    S.settings.clientKey = randomId(24);
    await api.storage.local.set({ settings: S.settings });
  }
  setupActionClick();
  // Resume a room after the browser stopped this worker.
  if (saved.session && saved.session.roomId) {
    try {
      await api.tabs.get(saved.session.tabId);
      S.roomId = saved.session.roomId;
      S.tabId = saved.session.tabId;
      connect(null);
    } catch {
      await api.storage.local.remove("session");
    }
  }
}

function setupActionClick() {
  if (api.sidePanel && api.sidePanel.setPanelBehavior) {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else if (api.sidebarAction) {
    api.action.onClicked.addListener(() => api.sidebarAction.toggle());
  } else {
    // Firefox for Android has no sidebar, so the panel opens as a popup.
    api.action.setPopup({ popup: "panel.html" });
  }
}

function randomId(len) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function server() {
  return (S.settings.serverUrl || "").replace(/\/+$/, "");
}

function inviteUrl() {
  return S.roomId ? `${server()}/r/${S.roomId}` : "";
}

function canControl() {
  return S.control === "everyone" || S.host || !S.hostOnline;
}

// ---------- room connection ----------

function connect(create) {
  closeSocket();
  const url = server().replace(/^http/, "ws") + `/api/rooms/${S.roomId}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    S.error = "The server address in Settings isn't valid.";
    pushPanels();
    return;
  }
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    S.retry = 0;
    S.error = "";
    send({ t: "hello", name: S.settings.name || "Guest", clientKey: S.settings.clientKey, kind: "ext", create: create || undefined });
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 400);
    startTimers();
    pushPanels();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.connected = false;
    S.ws = null;
    pushPanels();
    if (e.code === 4004) return;
    if (!S.roomId) return;
    const wait = Math.min(10000, 1000 * 2 ** S.retry++);
    setTimeout(() => { if (S.roomId && !S.ws) connect(null); }, wait);
  };
}

function closeSocket() {
  if (S.ws) {
    const ws = S.ws;
    S.ws = null;
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
  }
  S.connected = false;
}

function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function ping() {
  send({ t: "ping", c: Date.now() });
}

function startTimers() {
  if (S.timers.length) return;
  // Regular traffic also keeps the browser from stopping this worker mid-room.
  S.timers.push(setInterval(() => send({ t: "hb" }), 20000));
  S.timers.push(setInterval(ping, 60000));
}

function stopTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

function memberName(id) {
  const m = S.members.find((x) => x.id === id);
  return m ? m.name : "Someone";
}

function handle(msg) {
  switch (msg.t) {
    case "pong":
      S.clock.add(msg.c, msg.s, Date.now());
      toFrames({ type: "clock", offset: S.clock.offset });
      break;
    case "welcome": {
      if (!S.clock.samples.length) S.clock.offset = msg.serverTime - Date.now();
      S.you = msg.you;
      S.host = msg.host;
      S.control = msg.control;
      S.hostOnline = msg.hostOnline;
      S.members = msg.members;
      S.title = msg.title || "";
      S.chat = msg.chat || [];
      S.state = msg.state;
      followRoomUrl();
      toActive({ type: "state", state: S.state, offset: S.clock.offset });
      toFrames({ type: "perm", canControl: canControl() });
      pushPanels();
      break;
    }
    case "state": {
      const prev = S.state;
      S.state = msg.state;
      if (prev && SC.urlKey(prev.url) !== SC.urlKey(msg.state.url)) {
        if (msg.by !== S.you) toActive({ type: "toast", text: `${memberName(msg.by)} moved the room to another video` });
        followRoomUrl();
      } else if (prev && msg.by && msg.by !== S.you) {
        if (prev.intendsToPlay !== msg.state.intendsToPlay) toActive({ type: "toast", text: `${memberName(msg.by)} ${msg.state.intendsToPlay ? "pressed play" : "paused"}` });
        else if (Math.abs(SC.expectedPosition(prev, S.clock.now()) - msg.state.position) > 3) toActive({ type: "toast", text: `${memberName(msg.by)} jumped to ${SC.formatTime(msg.state.position)}` });
      }
      if (msg.state.waitingFor.length && (!prev || prev.waitingFor.join() !== msg.state.waitingFor.join())) {
        toActive({ type: "toast", text: `Waiting for ${msg.state.waitingFor.join(", ")}` });
      }
      toActive({ type: "state", state: S.state, offset: S.clock.offset });
      pushPanels();
      break;
    }
    case "members":
      S.members = msg.members;
      S.control = msg.control;
      S.hostOnline = msg.hostOnline;
      toFrames({ type: "perm", canControl: canControl() });
      pushPanels();
      break;
    case "chat":
      S.chat.push(msg.message);
      if (S.chat.length > 100) S.chat.shift();
      if (msg.message.from !== S.you) toActive({ type: "toast", text: `${msg.message.name}: ${msg.message.text}` });
      pushPanels({ chatOnly: true });
      break;
    case "error":
      if (msg.code === "slow-down") {
        toActive({ type: "toast", text: msg.message });
        break;
      }
      if (msg.code === "no-room") {
        S.error = msg.message || "This room has ended.";
        leaveRoom(true);
      }
      break;
  }
}

// Put the room's tab on the room's video if it's somewhere else.
async function followRoomUrl() {
  if (!S.state || S.tabId == null) return;
  let tab;
  try { tab = await api.tabs.get(S.tabId); } catch { return; }
  if (SC.urlKey(tab.url || "") === SC.urlKey(S.state.url)) return;
  S.followUntil = Date.now() + 15000;
  api.tabs.update(S.tabId, { url: S.state.url }).catch(() => {});
}

// ---------- starting, joining, leaving ----------

async function startRoom(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || "")) throw new Error("Open the video's page first, then start the room.");
  if (S.roomId) await leaveRoom(false);
  S.roomId = randomId(8);
  S.tabId = tabId;
  S.error = "";
  S.chat = [];
  await api.storage.local.set({ session: { roomId: S.roomId, tabId } });
  // Start the room where the host already is, not at the beginning.
  const now = await readVideo(tabId);
  connect({ url: tab.url, title: tab.title || "", position: now ? now.time : 0, playing: now ? now.playing : false, control: "everyone" });
  await inject(tabId);
}

async function readVideo(tabId) {
  const results = await api.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      let best = null, area = 0;
      for (const v of document.querySelectorAll("video")) {
        const r = v.getBoundingClientRect();
        if (r.width * r.height > area) { area = r.width * r.height; best = v; }
      }
      return best ? { area, time: best.currentTime, playing: !best.paused } : null;
    }
  }).catch(() => []);
  let pick = null;
  for (const r of results || []) if (r && r.result && (!pick || r.result.area > pick.area)) pick = r.result;
  return pick;
}

async function joinRoom(roomId, existingTabId) {
  const res = await fetch(`${server()}/api/rooms/${roomId}`).catch(() => null);
  if (!res || !res.ok) throw new Error(`Couldn't reach the Syncroom server at ${server()}. Check the address in Settings.`);
  const info = await res.json();
  if (!info.exists) throw new Error("That room has ended or the link is wrong.");
  if (S.roomId) await leaveRoom(false);
  let tab;
  if (existingTabId != null) tab = await api.tabs.update(existingTabId, { url: info.url, active: true });
  else tab = await api.tabs.create({ url: info.url, active: true });
  S.roomId = roomId;
  S.tabId = tab.id;
  S.error = "";
  S.chat = [];
  S.followUntil = Date.now() + 15000;
  await api.storage.local.set({ session: { roomId, tabId: tab.id } });
  connect(null);
}

async function leaveRoom(keepError) {
  toFrames({ type: "detach" });
  S.frames.clear();
  S.activeFrame = null;
  S.roomId = null;
  S.tabId = null;
  closeSocket();
  stopTimers();
  S.state = null;
  S.members = [];
  S.chat = [];
  S.title = "";
  if (!keepError) S.error = "";
  await api.storage.local.remove("session");
  pushPanels();
}

// ---------- the room's tab ----------

async function inject(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  await api.scripting.executeScript({ target, files: ["sync-core.js", "content.js"] }).catch(() => {});
  let tab;
  try { tab = await api.tabs.get(tabId); } catch { return; }
  if (/(^|\.)netflix\.com$/.test(hostname(tab.url)) && !frameIds) {
    await api.scripting.executeScript({ target: { tabId }, files: ["netflix-main.js"], world: "MAIN" }).catch(() => {});
  }
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

async function injectBridge(tabId) {
  await api.scripting.executeScript({ target: { tabId }, files: ["bridge.js"] }).catch(() => {});
}

function isServerPage(url) {
  const base = server();
  return !!base && !!url && (url === base || url.startsWith(base + "/"));
}

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await ready;
  if (info.status !== "complete") return;
  if (tabId === S.tabId) inject(tabId);
  else if (isServerPage(tab.url)) injectBridge(tabId);
});

// Video players often sit in frames that load after the page itself.
if (api.webNavigation) {
  api.webNavigation.onCompleted.addListener(async (d) => {
    await ready;
    if (d.tabId === S.tabId && d.frameId !== 0) inject(d.tabId, [d.frameId]);
  });
}

api.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabId === S.tabId) leaveRoom(false);
});

// ---------- frames in the room's tab ----------

function toFrames(msg) {
  for (const f of S.frames.values()) {
    try { f.port.postMessage(msg); } catch { /* frame gone */ }
  }
}

function toActive(msg) {
  const f = S.activeFrame != null && S.frames.get(S.activeFrame);
  if (f) {
    try { f.port.postMessage(msg); } catch { /* frame gone */ }
  }
}

// The largest video in the tab is the one we sync.
function chooseActive() {
  let best = null;
  for (const [id, f] of S.frames) {
    if (f.area > 0 && (!best || f.area > S.frames.get(best).area)) best = id;
  }
  if (best === S.activeFrame) return;
  const old = S.activeFrame != null && S.frames.get(S.activeFrame);
  if (old) old.port.postMessage({ type: "activate", on: false });
  S.activeFrame = best;
  const f = best != null && S.frames.get(best);
  if (f) f.port.postMessage({ type: "activate", on: true, state: S.state, offset: S.clock.offset, canControl: canControl() });
  pushPanels();
}

api.runtime.onConnect.addListener(async (port) => {
  await ready;
  if (port.name === "syncroom-panel") return attachPanel(port);
  if (port.name !== "syncroom-frame") return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  const frameId = port.sender.frameId || 0;
  if (tabId == null || tabId !== S.tabId) {
    port.postMessage({ type: "detach" });
    return;
  }
  S.frames.set(frameId, { port, area: 0 });
  port.onDisconnect.addListener(() => {
    if (S.frames.get(frameId) && S.frames.get(frameId).port === port) {
      S.frames.delete(frameId);
      if (S.activeFrame === frameId) S.activeFrame = null;
      chooseActive();
    }
  });
  port.onMessage.addListener((msg) => onFrameMessage(frameId, port, msg));
  port.postMessage({ type: "perm", canControl: canControl() });
});

async function onFrameMessage(frameId, port, msg) {
  const f = S.frames.get(frameId);
  if (!f || f.port !== port) return;
  switch (msg.type) {
    case "video":
      f.area = msg.area || 0;
      chooseActive();
      break;
    case "send":
      if (frameId === S.activeFrame && msg.msg && ["state", "buffering", "status"].includes(msg.msg.t)) send(msg.msg);
      break;
    case "ready":
      if (frameId === S.activeFrame) await maybeNavigate(msg);
      break;
  }
}

// When someone allowed to control opens a different video, the room follows.
async function maybeNavigate(msg) {
  if (!S.state || !S.connected || !canControl() || Date.now() < S.followUntil) return;
  if (!(msg.duration >= 30)) return;
  let tab;
  try { tab = await api.tabs.get(S.tabId); } catch { return; }
  if (!/^https?:/.test(tab.url || "")) return;
  if (SC.urlKey(tab.url) === SC.urlKey(S.state.url)) return;
  send({ t: "navigate", url: tab.url, title: tab.title || "", position: msg.position || 0, playing: !!msg.playing, at: msg.at });
}

// ---------- panel ----------

function snapshot() {
  return {
    type: "snapshot",
    settings: { name: S.settings.name, serverUrl: S.settings.serverUrl },
    inRoom: !!S.roomId,
    roomId: S.roomId,
    tabId: S.tabId,
    inviteUrl: inviteUrl(),
    connected: S.connected,
    you: S.you,
    host: S.host,
    canControl: canControl(),
    control: S.control,
    members: S.members,
    state: S.state,
    serverNow: S.clock.now(),
    title: S.title,
    chat: S.chat,
    videoFound: S.activeFrame != null,
    error: S.error
  };
}

function pushPanels() {
  const snap = snapshot();
  for (const p of S.panels) {
    try { p.postMessage(snap); } catch { /* panel closed */ }
  }
}

function attachPanel(port) {
  S.panels.add(port);
  port.onDisconnect.addListener(() => S.panels.delete(port));
  port.onMessage.addListener(async (msg) => {
    try {
      await onPanelMessage(msg);
    } catch (err) {
      S.error = err && err.message ? err.message : "Something went wrong.";
    }
    pushPanels();
  });
  port.postMessage(snapshot());
}

async function onPanelMessage(msg) {
  switch (msg.type) {
    case "start":
      await saveSettings({ name: msg.name });
      await startRoom(msg.tabId);
      break;
    case "join": {
      await saveSettings({ name: msg.name });
      const id = parseRoomCode(msg.code);
      if (!id) throw new Error("That isn't a Syncroom invite link or code.");
      await joinRoom(id, null);
      break;
    }
    case "leave":
      await leaveRoom(false);
      break;
    case "chat":
      send({ t: "chat", text: String(msg.text || "").slice(0, 500) });
      break;
    case "control":
      send({ t: "settings", control: msg.control });
      break;
    case "settings": {
      const before = server();
      await saveSettings(msg.settings);
      if (msg.settings.name) send({ t: "rename", name: msg.settings.name });
      if (S.roomId && server() !== before) await leaveRoom(false);
      break;
    }
    case "focus":
      if (S.tabId != null) {
        const tab = await api.tabs.update(S.tabId, { active: true });
        if (api.windows && tab.windowId != null) api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      break;
    case "voice": {
      const url = `${inviteUrl()}?voice=1`;
      if (api.windows && api.windows.create) await api.windows.create({ url, type: "popup", width: 420, height: 640 });
      else await api.tabs.create({ url });
      break;
    }
    case "dismiss":
      S.error = "";
      break;
  }
}

function parseRoomCode(text) {
  text = String(text || "").trim().toLowerCase();
  const m = text.match(/\/r\/([a-z0-9]{6,16})/) || text.match(/^([a-z0-9]{6,16})$/);
  return m ? m[1] : null;
}

async function saveSettings(patch) {
  if (!patch) return;
  if (typeof patch.name === "string" && patch.name.trim()) S.settings.name = patch.name.trim().slice(0, 32);
  if (typeof patch.serverUrl === "string" && /^https?:\/\/[^ ]+$/.test(patch.serverUrl.trim())) S.settings.serverUrl = patch.serverUrl.trim().replace(/\/+$/, "");
  await api.storage.local.set({ settings: S.settings });
}

// ---------- invite pages on the Syncroom site ----------

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "bridge-join") return;
  (async () => {
    await ready;
    if (!sender.tab || !isServerPage(sender.url || sender.tab.url)) return;
    if (msg.name) await saveSettings({ name: msg.name });
    try {
      await joinRoom(parseRoomCode(msg.roomId), null);
    } catch (err) {
      S.error = err.message;
    }
    pushPanels();
  })();
});
