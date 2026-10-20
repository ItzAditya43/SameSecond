// Syncroom room server: a Cloudflare Worker that serves the web app and
// gives every room its own Durable Object. The room only relays small
// messages (play, pause, seek, chat, voice signalling); video never passes
// through here.

import { DurableObject } from "cloudflare:workers";

const ROOM_ID = /^[a-z0-9]{6,16}$/;
const MAX_MESSAGE = 16 * 1024;
const CHAT_HISTORY = 50;
const BUFFER_TIMEOUT = 15_000;
const ROOM_TTL = 24 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "api") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
      }
      if (parts[1] === "rooms" && parts[2]) {
        const id = parts[2].toLowerCase();
        if (!ROOM_ID.test(id)) return json({ error: "bad-room-id" }, 400);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        const inner = new URL(request.url);
        inner.pathname = parts[3] === "ws" ? "/ws" : "/info";
        inner.searchParams.set("room", id);
        return stub.fetch(new Request(inner, request));
      }
      if (parts[1] === "ice") return json({ iceServers: await iceServers(env) });
      if (parts[1] === "health") return json({ ok: true });
      return json({ error: "not-found" }, 404);
    }
    if (url.pathname === "/" || /^\/r\/[a-z0-9]{6,16}\/?$/.test(url.pathname)) return page(request, env, url);
    return env.ASSETS.fetch(request);
  }
};

// Fills in link-preview tags, so an invite pasted into Discord or WhatsApp
// shows what the room is watching.
async function page(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  let title = null;
  let description = null;
  const m = url.pathname.match(/^\/r\/([a-z0-9]{6,16})\/?$/);
  if (m) {
    try {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      const info = await (await stub.fetch(`https://room/info?room=${m[1]}`)).json();
      if (info.exists) {
        let site = "";
        try { site = new URL(info.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
        title = info.title ? `Join my watch party: ${info.title}` : "Join my watch party on Syncroom";
        const here = info.members === 1 ? "1 person is here" : `${info.members} people are here`;
        description = `Watching${site ? " on " + site : ""} with Syncroom. ${here}.`;
      }
    } catch { /* fall back to the defaults in the page */ }
  }
  const set = (value) => ({ element(el) { el.setAttribute("content", value); } });
  let rw = new HTMLRewriter()
    .on('meta[property="og:image"]', set(`${url.origin}/og.png`))
    .on("head", { element(el) { el.append(`<meta property="og:url" content="${url.origin}${url.pathname}">`, { html: true }); } });
  if (title) rw = rw.on('meta[property="og:title"]', set(title));
  if (description) rw = rw.on('meta[property="og:description"]', set(description));
  return rw.transform(res);
}

// STUN is enough for most home networks. If Cloudflare TURN keys are set as
// secrets, short-lived TURN credentials are added for the networks that need a relay.
async function iceServers(env) {
  const base = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return base;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 86400 })
    });
    if (!res.ok) return base;
    const data = await res.json();
    const extra = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    return base.concat(extra);
  } catch {
    return base;
  }
}

function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function cleanUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.slice(0, 2048);
  } catch {
    return null;
  }
}

// When the sender says (in server time) its position was read. Using it
// instead of the arrival time keeps the room from trailing the sender by the
// network delay. Implausible values fall back to now.
function sentAt(at, now) {
  const t = Number(at);
  return Number.isFinite(t) && t <= now && t > now - 5000 ? t : now;
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    // Answer heartbeats without waking the room from hibernation.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'));
  }

  async load() {
    if (!this.room) this.room = (await this.ctx.storage.get("room")) || null;
    return this.room;
  }

  async save() {
    await this.ctx.storage.put("room", this.room);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room");
    if (url.pathname === "/info") {
      const room = await this.load();
      if (!room) return json({ exists: false });
      return json({
        exists: true,
        id: room.id,
        url: room.state.url,
        title: room.title,
        members: this.members().filter((m) => m.kind !== "voice").length
      });
    }
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected-websocket" }, 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: newId(), roomId, joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.joined;
    });
  }

  members() {
    const room = this.room;
    return this.sockets().map((ws) => {
      const a = ws.deserializeAttachment();
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        host: !!room && a.clientKey === room.hostKey,
        voice: !!a.voice,
        status: a.status || null
      };
    });
  }

  hostOnline() {
    return this.sockets().some((ws) => ws.deserializeAttachment().clientKey === this.room.hostKey);
  }

  canControl(att) {
    const room = this.room;
    if (!room) return false;
    if (att.kind === "voice") return false;
    return room.control === "everyone" || att.clientKey === room.hostKey || !this.hostOnline();
  }

  // Position the room's clock is at right now.
  currentPosition(now = Date.now()) {
    const s = this.room.state;
    return s.playing && this.room.waiting.length === 0 ? s.position + (now - s.updatedAt) / 1000 : s.position;
  }

  // The state clients follow. While someone is buffering the room holds still.
  publicState() {
    const room = this.room;
    const s = room.state;
    return {
      url: s.url,
      playing: s.playing && room.waiting.length === 0,
      intendsToPlay: s.playing,
      position: s.position,
      updatedAt: s.updatedAt,
      waitingFor: room.waiting.map((w) => w.name),
      seq: s.seq
    };
  }

  // Freeze the clock at the current position before anything that changes it.
  freeze(now = Date.now()) {
    const s = this.room.state;
    s.position = this.currentPosition(now);
    s.updatedAt = now;
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* socket closing */ }
    }
  }

  broadcastState(by) {
    this.room.state.seq = (this.room.state.seq || 0) + 1;
    this.broadcast({ t: "state", state: this.publicState(), by, serverTime: Date.now() });
  }

  broadcastMembers() {
    this.broadcast({ t: "members", members: this.members(), control: this.room.control, hostOnline: this.hostOnline() });
  }

  expireWaiting(now = Date.now()) {
    const before = this.room.waiting.length;
    if (!before) return false;
    const live = new Set(this.sockets().map((ws) => ws.deserializeAttachment().id));
    const wasHolding = before > 0;
    const kept = this.room.waiting.filter((w) => live.has(w.id) && now - w.since < BUFFER_TIMEOUT);
    if (kept.length === before) return false;
    if (wasHolding) this.freeze(now);
    this.room.waiting = kept;
    return true;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const att = ws.deserializeAttachment();
    const now = Date.now();

    if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", c: msg.c, s: now }));
      return;
    }

    if (msg.t === "hello") return this.hello(ws, att, msg, now);
    if (!att.joined) return;
    await this.load();
    if (!this.room) return;

    let changed = this.expireWaiting(now);

    switch (msg.t) {
      case "state": {
        if (!this.canControl(att)) break;
        const position = Number(msg.position);
        if (!Number.isFinite(position) || position < 0) break;
        const s = this.room.state;
        s.playing = !!msg.playing;
        s.position = position;
        s.updatedAt = sentAt(msg.at, now);
        // A manual play or seek overrides anyone still waiting to load.
        this.room.waiting = [];
        await this.save();
        this.broadcastState(att.id);
        changed = false;
        break;
      }
      case "navigate": {
        if (!this.canControl(att)) break;
        const url = cleanUrl(msg.url);
        if (!url) break;
        const s = this.room.state;
        s.url = url;
        s.position = Math.max(0, Number(msg.position) || 0);
        s.playing = !!msg.playing;
        s.updatedAt = sentAt(msg.at, now);
        this.room.title = cleanText(msg.title, 120);
        this.room.waiting = [];
        await this.save();
        this.broadcastState(att.id);
        this.broadcastMembers();
        changed = false;
        break;
      }
      case "buffering": {
        const on = !!msg.on;
        const has = this.room.waiting.some((w) => w.id === att.id);
        if (on === has || att.kind === "voice") break;
        this.freeze(now);
        if (on) this.room.waiting.push({ id: att.id, name: att.name, since: now });
        else this.room.waiting = this.room.waiting.filter((w) => w.id !== att.id);
        changed = true;
        break;
      }
      case "status": {
        att.status = {
          ready: !!msg.ready,
          playing: !!msg.playing,
          position: Number(msg.position) || 0,
          buffering: !!msg.buffering,
          at: now
        };
        ws.serializeAttachment(att);
        this.broadcastMembers();
        break;
      }
      case "chat": {
        const text = cleanText(msg.text, 500);
        if (!text) break;
        const entry = { id: newId(), from: att.id, name: att.name, text, at: now };
        this.room.chat.push(entry);
        if (this.room.chat.length > CHAT_HISTORY) this.room.chat.splice(0, this.room.chat.length - CHAT_HISTORY);
        await this.save();
        this.broadcast({ t: "chat", message: entry });
        break;
      }
      case "settings": {
        if (att.clientKey !== this.room.hostKey) break;
        if (msg.control === "everyone" || msg.control === "host") this.room.control = msg.control;
        await this.save();
        this.broadcastMembers();
        break;
      }
      case "voice": {
        att.voice = !!msg.on;
        ws.serializeAttachment(att);
        this.broadcastMembers();
        break;
      }
      case "signal": {
        const target = this.sockets().find((s) => s.deserializeAttachment().id === msg.to);
        if (target) target.send(JSON.stringify({ t: "signal", from: att.id, data: msg.data }));
        break;
      }
      case "rename": {
        att.name = cleanText(msg.name, 32) || att.name;
        ws.serializeAttachment(att);
        this.broadcastMembers();
        break;
      }
    }

    if (changed) {
      await this.save();
      this.broadcastState(att.id);
    }
  }

  async hello(ws, att, msg, now) {
    await this.load();
    const clientKey = cleanText(msg.clientKey, 64);
    if (!clientKey) return ws.close(4000, "missing-client-key");

    if (!this.room) {
      const url = msg.create && cleanUrl(msg.create.url);
      if (!url) {
        ws.send(JSON.stringify({ t: "error", code: "no-room", message: "This room has ended or the link is wrong." }));
        return ws.close(4004, "no-room");
      }
      this.room = {
        id: att.roomId,
        hostKey: clientKey,
        control: msg.create.control === "host" ? "host" : "everyone",
        title: cleanText(msg.create.title, 120),
        createdAt: now,
        state: { url, playing: !!msg.create.playing, position: Math.max(0, Number(msg.create.position) || 0), updatedAt: now, seq: 0 },
        waiting: [],
        chat: []
      };
      await this.save();
    }
    await this.ctx.storage.deleteAlarm();

    att.joined = true;
    att.clientKey = clientKey;
    att.name = cleanText(msg.name, 32) || "Guest";
    att.kind = ["ext", "web", "voice"].includes(msg.kind) ? msg.kind : "web";
    att.voice = false;
    att.status = null;
    ws.serializeAttachment(att);

    this.expireWaiting(now);
    ws.send(JSON.stringify({
      t: "welcome",
      you: att.id,
      host: clientKey === this.room.hostKey,
      roomId: this.room.id,
      title: this.room.title,
      state: this.publicState(),
      serverTime: now,
      control: this.room.control,
      members: this.members(),
      hostOnline: this.hostOnline(),
      chat: this.room.chat
    }));
    this.broadcastMembers();
  }

  async webSocketClose(ws) {
    await this.leave(ws);
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  async leave(ws) {
    const att = ws.deserializeAttachment();
    att.joined = false;
    try { ws.serializeAttachment(att); } catch { /* already gone */ }
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
    await this.load();
    if (!this.room) return;
    if (this.room.waiting.some((w) => w.id === att.id)) {
      this.freeze();
      this.room.waiting = this.room.waiting.filter((w) => w.id !== att.id);
      await this.save();
      this.broadcastState(att.id);
    }
    this.broadcastMembers();
    if (this.sockets().length === 0) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
  }

  // A room nobody has been in for a day is deleted.
  async alarm() {
    if (this.sockets().length > 0) return;
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
