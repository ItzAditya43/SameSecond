// Hide the download button if this server hasn't published a build.
fetch("/downloads/syncroom-extension.zip", { method: "HEAD" }).then(function (r) {
  var ok = r.ok && /zip|octet/.test(r.headers.get("content-type") || "");
  if (!ok) {
    document.getElementById("dl").hidden = true;
    document.getElementById("dl-note").textContent = "No download is published on this site yet. Ask whoever runs it to deploy with npm run deploy.";
  }
}).catch(function () {});
