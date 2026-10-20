// Runs on Syncroom's own invite pages so they can tell the extension is
// installed and hand a room over to it.
(function () {
  "use strict";
  if (window.__syncroomBridge) return;
  window.__syncroomBridge = true;
  var api = globalThis.browser || globalThis.chrome;
  document.documentElement.dataset.syncroomExt = api.runtime.getManifest().version;
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "syncroom-page") return;
    if (e.data.type === "join" && typeof e.data.roomId === "string") {
      api.runtime.sendMessage({ type: "bridge-join", roomId: e.data.roomId, name: String(e.data.name || "") });
    }
  });
})();
