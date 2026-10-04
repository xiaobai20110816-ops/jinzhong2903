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

  const got = await env.STORY_KV.getWithMetadata("gal:" + key, { type: "arrayBuffer" });
  if (!got || !got.value) return new Response("Not found", { status: 404 });

  return new Response(got.value, {
    headers: {
      "content-type": (got.metadata && got.metadata.ct) || "image/jpeg",
      "content-length": String(got.value.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}