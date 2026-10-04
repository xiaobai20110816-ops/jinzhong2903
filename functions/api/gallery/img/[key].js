/* ============================================================
   103 纪事 · 图库读图
   GET /api/gallery/img/:key   从 KV 取原图或缩略图
   每张都是不变量,可以长缓存
   ============================================================ */

import { GALLERY_KEY_RE } from "../../_utils.js";

export async function onRequestGet({ env, params }) {
  if (!env.STORY_KV) return new Response("图片存储还没接上", { status: 503 });

  const key = params.key;
  if (!GALLERY_KEY_RE.test(key)) return new Response("Not found", { status: 404 });

  const kvKey = "gal:" + key;

  // 用 stream 取,边读边发,不像 arrayBuffer 那样要先把整张(可能 5MB)全读进内存
  // 再往外发 —— 起播更快、内存占用更低。个别环境不支持就退回 arrayBuffer。
  let got = null;
  try {
    got = await env.STORY_KV.getWithMetadata(kvKey, { type: "stream" });
  } catch (e) {
    got = null;
  }
  if (!got || !got.value) {
    const buf = await env.STORY_KV.get(kvKey, { type: "arrayBuffer" });
    if (!buf) return new Response("Not found", { status: 404 });
    got = { value: buf, metadata: null };
  }

  const meta = got.metadata || {};
  const headers = {
    "content-type": meta.ct || "image/jpeg",
    "cache-control": "public, max-age=31536000, immutable",
  };
  // 有记录就带上长度,浏览器下载能显示进度;老图没记就交给分块传输
  if (meta.size) headers["content-length"] = String(meta.size);
  else if (typeof got.value.byteLength === "number") headers["content-length"] = String(got.value.byteLength);

  return new Response(got.value, { headers });
}
