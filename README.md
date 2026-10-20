# Syncroom

Free watch parties. Everyone plays the video on their own device and Syncroom keeps the players on the same second. Video never passes through Syncroom, so there's no re-stream lag, DRM sites like Netflix keep working, and there's nothing to pay for.

| Part | What it does | Runs on |
|---|---|---|
| `server/` | Room server. One small object per room relays play, pause, seek, chat and voice-call setup. Also serves the website and fills in invite link previews. | Cloudflare Workers + Durable Objects (free tier) |
| `public/` | Website: landing page, invite links, and a room for YouTube and direct video links (`.mp4`, `.m3u8`) with chat and voice. Works on phones and laptops, and can be added to a phone's home screen. | Served by the Worker |
| `extension/` | Browser extension that syncs the video on any site (Netflix, Crunchyroll, YouTube…), with a side panel for people, chat and the invite link. | Chrome, Edge, Brave, Opera, Firefox, Firefox for Android |
| `shared/sync-core.js` | Sync engine used by both the website and the extension. | |
| `store/` | Store listing text, permission justifications, promo images. | |

## How sync works

- The room keeps one clock: `{ playing, position, updatedAt }`. Where playback should be now is `position + (now − updatedAt)` while playing.
- Every change is stamped with the time it was sent (in server time), so the room doesn't trail the sender by the network delay.
- Each device measures the offset between its clock and the server's, and checks itself once a second:
  - under 0.06 s off: leave it alone
  - 0.06–0.5 s off: play up to 10% faster or slower, in proportion to the gap, until caught up
  - over 0.5 s off: jump to the right position (0.8 s for YouTube and 1 s for Netflix, whose seeks are slow)
- When someone's video stalls for more than a second, the room holds until they've loaded (up to 15 s, or until they leave).
- When a browser refuses to start playback until the viewer taps (phones), that player stays out of the room's way and shows a "Tap to start watching" bar.
- The extension only shares play, pause and seek when they follow a real click or key press, so autoplay and site scripts can't hijack the room.
- When someone allowed to control opens a different episode, everyone's tab follows.
- Netflix's player crashes if the video element is seeked directly, so the extension seeks through Netflix's own player API (`extension/netflix-main.js`). YouTube adverts pause syncing until they finish.

## Run it locally

```sh
npm install
npm run dev          # website and room server on http://localhost:8787
```

Load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension/` folder. It points at `http://localhost:8787` by default (`extension/config.js`).

For Firefox: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `extension/manifest.json`.

## Deploy (free)

```sh
npx wrangler login   # opens Cloudflare in your browser; a free account is enough
npm run deploy
```

`npm run deploy` publishes the site, finds its `…workers.dev` address, builds the extension pointed at that address, and publishes again so the site offers it at `/downloads/syncroom-extension.zip`. It also writes `dist/syncroom-extension.zip` for store uploads. The address is remembered in `.syncroom-url`; for a custom domain run `npm run deploy -- https://your.domain`.

Optional: if some friends can't connect voice (strict networks), create a TURN key in the Cloudflare dashboard (Realtime → TURN) and add it:

```sh
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

### Getting the extension to people

| Where | Cost | Notes |
|---|---|---|
| Your site's download page | Free | Friends unzip it and use "Load unpacked" in Chrome, Edge, Brave or Opera. Steps are on `/extension.html`. |
| Chrome Web Store | One-time $5 | Reaches Chrome and Brave users with one click. Review usually takes a few days. |
| Microsoft Edge Add-ons | Free | Same zip. |
| Opera Add-ons | Free | Same zip. |
| Firefox Add-ons (AMO) | Free | Firefox only installs signed add-ons, so this is the way for Firefox. A public listing is also what makes it installable on Firefox for Android. |

Listing text, permission justifications and images are in [`store/LISTING.md`](store/LISTING.md). The privacy policy the stores ask for is served at `/privacy.html`.

## Phones

- Any phone can open an invite link to watch YouTube and video-link rooms, and to chat and talk in any room.
- Firefox for Android runs the extension, for sites that play in a phone browser.
- Netflix and similar sites don't play in phone browsers at all, so phone users join those rooms for chat and voice only.
- iPhones can't run this extension (Safari extensions need a Mac and a paid Apple developer account).

## Tests

```sh
npm test                                   # sync engine + room server (starts wrangler dev itself)
npm run test:browser                       # real Chromium: website, extension, invite handoff, restarts
npm run test:browser -- firefox youtube    # also Firefox, and real YouTube (needs internet)
npm run lint:extension                     # Mozilla's extension linter
```

Browser tests need Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`), ffmpeg to generate test media, and for the `firefox` option Firefox (`FIREFOX_PATH`). GitHub Actions runs `npm test`, the linter and the Chrome browser suites on every push.

| Suite | Covers |
|---|---|
| `scripts/smoke-test.mjs` | Sync engine decisions, clock sync, the room protocol, permissions, buffering holds, link previews, malformed input |
| `tests/browser/web.mjs` | Two people in the website: play, seek, drift correction, pause, chat, two-way voice, host-only control (Chromium and Firefox) |
| `tests/browser/extras.mjs` | HLS streams, blocked autoplay on phones, reloads, three people with three-way voice, hostile chat, static pages |
| `tests/browser/ext.mjs` | The extension on a video tab with a website user; the panel's own buttons and forms |
| `tests/browser/bridge.mjs` | Invite page → "Open in the extension" → synced tab (Chromium and Firefox) |
| `tests/browser/resilience.mjs` | Server restart mid-room; the browser stopping the extension's background worker |
| `tests/browser/youtube.mjs` | Real YouTube: embedded players and the extension on youtube.com in one room |

Not covered by automated tests: Netflix and Crunchyroll (they need real accounts), real phones, and Safari/WebKit (it can't run on Arch Linux without extra system packages). Check those by hand before relying on them.

## Files worth knowing

- `shared/sync-core.js`: edit here; `npm run shared` copies it into `public/` and `extension/` (the dev, deploy and test scripts do this automatically).
- `extension/content.js`: finds the largest video on the page and keeps it in sync; site-specific behaviour (YouTube adverts, Netflix seeking) is in `makeAdapter`.
- `extension/background.js`: room connection, tab following, panel.
- `server/index.js`: the `Room` Durable Object, the message protocol and link previews.
