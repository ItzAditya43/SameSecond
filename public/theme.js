// Light / dark / follow-device theme switch. Loaded in <head> so the page never flashes the wrong theme.
(function () {
  var KEY = "samesecond.theme";
  var get = function () { try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; } };
  var apply = function (t) {
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  };
  apply(get());
  var labels = { system: "Theme: auto", light: "Theme: light", dark: "Theme: dark" };
  var next = { system: "light", light: "dark", dark: "system" };
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("theme-toggle");
    if (!b) return;
    var show = function () { b.textContent = labels[get()]; };
    show();
    b.addEventListener("click", function () {
      var t = next[get()];
      try { localStorage.setItem(KEY, t); } catch (e) { /* storage blocked */ }
      apply(t); show();
    });
  });
})();
