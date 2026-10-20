// Static file server with HTTP Range support, so videos can seek.
import http from "node:http";
import { statSync, createReadStream } from "node:fs";
const dir = new URL("./media/", import.meta.url).pathname;
http.createServer((req, res) => {
  const file = dir + decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "").replace(/\.\./g, "");
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end(); }
  const types = { mp4: "video/mp4", m3u8: "application/vnd.apple.mpegurl", ts: "video/mp2t", html: "text/html" };
  const type = types[file.split(".").pop()] || "application/octet-stream";
  res.setHeader("access-control-allow-origin", "*");
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : st.size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": st.size });
    createReadStream(file).pipe(res);
  }
}).listen(8800, "127.0.0.1");
