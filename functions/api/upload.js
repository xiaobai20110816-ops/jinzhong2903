/* ============================================================
   103 纪事 · 图片上传
   POST /api/upload   body = 图片二进制(前端已压到 1MB 以内)
   返回 { ok, key },发帖时把 key 放进 images 数组
   ============================================================ */

import { json, fail, notReady, randomHex, ensureSchema, currentUser, classGate } from "./_utils.js";

const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_BYTES = 1572864; // 1.5MB:前端压到 1MB 内,这里留点余量

export async function onRequestPost({ request, env }) {
  if (!env.STORY_KV) return notReady("图片存储");
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  // 登录了才能传图,不然会被人当免费图床刷
  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return fail("只收 JPG / PNG / WebP 图片");

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return fail("这张图是空的");
  if (buf.byteLength > MAX_BYTES) return fail("图片还是太大，请重新压缩后再传", 413);

  const key = randomHex(16) + "." + ext;
  await env.STORY_KV.put("img:" + key, buf, { metadata: { ct: type } });

  return json({ ok: true, key });
}
