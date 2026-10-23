// Offer this site's own copy of the extension too, when the site has one.
fetch("/downloads/samesecond-extension.zip", { method: "HEAD" }).then(function (r) {
  var ok = r.ok && /zip|octet/.test(r.headers.get("content-type") || "");
  if (ok) document.getElementById("dl").hidden = false;
}).catch(function () {});
