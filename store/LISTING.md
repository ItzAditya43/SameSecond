# Store listing

Copy-paste material for the Chrome Web Store, Microsoft Edge Add-ons, Opera Add-ons and Firefox Add-ons (AMO). Upload `dist/syncroom-extension.zip` from `npm run deploy`, which points the extension at your live site.

## Name

Syncroom

## Short description (max 132 characters)

Watch Netflix, YouTube, Crunchyroll and more with friends, in sync. Everyone plays their own video, so there's no lag.

## Category

Social & Communication (Chrome) · Social & Communication (Edge) · Social & Communication (Firefox)

## Detailed description

Syncroom keeps your group on the same second of the same episode.

Open an episode, click Syncroom and start a room. Send the invite link to your friends. When anyone presses play, pause or skips ahead, everyone's player follows within a fraction of a second.

Unlike screen-sharing watch parties, nothing is re-streamed. Everyone plays the video on their own device at full quality, signed in to their own account, so there's no lag and no blurry picture.

- Works on Netflix, YouTube, Crunchyroll and most sites with a video player
- Chat and voice chat built in
- Follows the host to the next episode automatically
- Waits for anyone whose video is still loading
- Host can choose who controls playback
- Friends on phones can join YouTube and video-link rooms from the invite link, and chat and talk in any room
- No account, no ads, free

Everyone in the room needs their own access to the site you're watching.

## Single purpose (Chrome)

Syncroom synchronises video playback in one browser tab with friends in the same watch-party room, with chat.

## Permission justifications (Chrome)

| Permission | Why |
|---|---|
| `storage` | Saves the user's display name, the server address and the room they're in, so the room survives a browser restart. |
| `tabs` | Finds the tab the room is in, moves that tab to the next episode when the room does, and opens the room's video when joining from an invite. |
| `scripting` | Injects the sync script into the room's tab only, after the user starts or joins a room. |
| `webNavigation` | Detects when a video player frame finishes loading inside the room's tab, so the sync script can reach players that load after the page. |
| `sidePanel` | Shows the room's invite link, people and chat beside the video. |
| Host permission `<all_urls>` | The video can be on any site the user chooses. The script runs only in the one tab the user starts or joins a room in, and on the Syncroom site's own invite pages. |

Remote code: **No.** All code ships in the package.

## Data usage (Chrome "Privacy practices" tab, and Firefox)

Collected and sent to the Syncroom server:
- **Website content / browsing activity:** the address of the video page the room is watching, and play, pause and position updates.
- **Personal communications:** chat messages and the display name the user types.

Declarations: not sold, not used for unrelated purposes, not used for credit decisions. Privacy policy URL: `https://<your-site>/privacy.html`.

Firefox: the manifest already declares `browsingActivity`, `websiteActivity` and `personalCommunications` under `data_collection_permissions`.

## Images

| File | Use |
|---|---|
| `extension/icons/128.png` | Store icon |
| `store/promo-small-440x280.png` | Chrome small promo tile (required) |
| `store/promo-marquee-1400x560.png` | Chrome marquee (optional) |
| `store/screenshots/*.png` | Screenshots, 1280×800 |

Regenerate the promo images with `node store/make-assets.mjs`.

## Fees

| Store | Cost |
|---|---|
| Chrome Web Store | One-time $5 registration |
| Microsoft Edge Add-ons | Free |
| Firefox Add-ons (AMO) | Free |
| Opera Add-ons | Free |
