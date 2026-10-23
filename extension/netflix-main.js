// Runs in Netflix's own page context. Netflix's player breaks if the video
// element is changed directly, so play, pause and seek go through its API.
(function () {
  "use strict";
  if (window.__samesecondNetflix) return;
  window.__samesecondNetflix = true;

  function player() {
    try {
      var vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      var ids = vp.getAllPlayerSessionIds();
      var id = ids.find(function (s) { return s.indexOf("watch") === 0; }) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (e) {
      return null;
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.__samesecond !== "nf") return;
    var p = player();
    if (!p) return;
    if (e.data.cmd === "seek" && typeof e.data.ms === "number") p.seek(e.data.ms);
    else if (e.data.cmd === "play") p.play();
    else if (e.data.cmd === "pause") p.pause();
  });
})();
