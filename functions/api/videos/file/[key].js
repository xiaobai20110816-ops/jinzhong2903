/* ============================================================
   103 · 视频取流
   GET /api/videos/file/:key
   视频一律在 B2 私有桶里,本 Function 用 SigV4 签名去取再转发。

   和图片不同的是:视频必须支持 Range —— 浏览器拖动进度条时只讨一段,
   所以带 Range 的请求原样透传(206 + Content-Range),不进边缘缓存;
   不带 Range 的整段请求才写 caches.default。
   B2 是 Cloudflare Bandwidth Alliance 成员,B2 → CF 这段流量免费。
   ============================================================ */

import { VIDEO_KEY_RE } from "../../_utils.js";
import { b2Config, videoObjectName, s3Get } from "../../_b2.js";

const CACHE_CTRL = "public, max-age=31536000, immutable";

export async function onRequestGet({ request, env, params, waitUntil }) {
  const key = params.key;
  if (!VIDEO_KEY_RE.test(key)) return new Response("Not found", { status: 404 });

  const b2 = await b2Config(env, env.DB);
  if (!b2.ready) return new Response("B2 还没配置好", { status: 503 });

  const range = request.headers.get("range") || "";
  const cache = !range && typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const got = await s3Get(b2, videoObjectName(key), range);
  if (got.status === 404) return new Response("Not found", { status: 404 });
  if (!got.ok && got.status !== 206) {
    const msg = await got.text().catch(() => "");
    return new Response("B2 读取失败：" + (String(msg).slice(0, 200) || got.status), { status: 502 });
  }

  const headers = new Headers();
  // 这几个头必须透传:浏览器靠它们判断能不能拖进度、总时长是多少
  for (const h of [
    "content-type",
    "content-length",
    "etag",
    "content-range",
    "accept-ranges",
    "last-modified",
  ]) {
    const v = got.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("cache-control", CACHE_CTRL);

  const res = new Response(got.body, { status: got.status, headers });

  if (cache) {
    const put = cache.put(cacheKey, res.clone()).catch(() => {});
    if (waitUntil) waitUntil(put);
    else await put;
  }
  return res;
}
