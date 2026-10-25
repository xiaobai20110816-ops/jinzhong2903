/* 临时排查接口:图库点开大图为什么是破图。
   /api/gallprobe?k=gp-4d19c7e6
   检查最近几张图的原图到底在 KV 还是 B2、能不能取到、content-type 对不对。
   排查完删除本文件。 */

import { json, ensureSchema } from "./_utils.js";
import { b2Config, isB2Key, b2ObjectName, s3Get } from "./_b2.js";

const KEY = "gp-4d19c7e6";

async function kvProbe(env, key) {
  if (!env.STORY_KV) return { where: "kv", error: "no-kv" };
  try {
    const got = await env.STORY_KV.getWithMetadata("gal:" + key, { type: "stream" });
    if (!got || !got.value) return { where: "kv", found: false };
    const rd = got.value.getReader();
    const first = await rd.read();
    const size = first && first.value ? first.value.byteLength : 0;
    try {
      await rd.cancel();
    } catch (e) {}
    return { where: "kv", found: true, meta: got.metadata || null, firstChunk: size };
  } catch (e) {
    return { where: "kv", error: String((e && e.message) || e).slice(0, 160) };
  }
}

async function b2Probe(env, key) {
  const b2 = await b2Config(env, env.DB).catch(() => null);
  if (!b2 || !b2.ready) return { where: "b2", error: "b2-not-ready" };
  const out = { where: "b2" };
  try {
    const got = await s3Get(b2, b2ObjectName(key), "bytes=0-1023");
    out.status = got.status;
    out.ok = got.ok || got.status === 206;
    out.ct = got.headers.get("content-type");
    out.rangeLen = got.headers.get("content-length");
    out.rangeCr = got.headers.get("content-range");
    const buf = new Uint8Array(await got.arrayBuffer().catch(() => new ArrayBuffer(0)));
    out.head = Array.from(buf.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  // 再按浏览器的方式完整取一次(不带 Range),看真实字节量和首字节魔数
  try {
    const full = await s3Get(b2, b2ObjectName(key), "");
    const ab = await full.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const magic = Array.from(u8.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
    out.whole = {
      status: full.status,
      ct: full.headers.get("content-type"),
      len: u8.byteLength,
      magic,
      isJpeg: magic.startsWith("ffd8ff"),
      isPng: magic === "89504e47",
      isWebp: magic === "52494646",
    };
  } catch (e) {
    out.wholeError = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return json({ ok: false, error: "no" }, 404);
  if (!env || !env.DB) return json({ ok: false, error: "no-db" }, 500);
  await ensureSchema(env.DB);

  const { results } = await env.DB.prepare(
    "SELECT id, title, full_key, thumb_key, full_size, upload_level, uploaded_by FROM gallery ORDER BY id DESC LIMIT 5"
  )
    .all();

  const rows = [];
  for (const r of results || []) {
    const out = { id: r.id, title: r.title, full_key: r.full_key, thumb_key: r.thumb_key, full_size: r.full_size, level: r.upload_level };
    // 缩略图(网格里能显示的那张)
    out.thumb = await kvProbe(env, r.thumb_key);
    out.full = isB2Key(r.full_key) ? await b2Probe(env, r.full_key) : await kvProbe(env, r.full_key);
    rows.push(out);
  }

  return json({ ok: true, rows });
}
