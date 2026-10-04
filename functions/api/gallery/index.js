/* ============================================================
   103 纪事 · 班级图库
   POST /api/gallery        上传一张图(原图 + 缩略图,multipart)
   GET  /api/gallery        图库列表(游客也能看缩略图)

   原图每张 5MB 左右,前端只把缩略图压到几百 KB;两张图都存 KV,
   D1 的 gallery 表只记元数据。下载时走 /api/gallery/img/<key>。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  randomHex,
} from "./_utils.js";

const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// 图库的图片格式:原图 allow JPEG 体积大,缩略图两边都存 KV。体积上限分开设
// 原图:预留 8MB(5MB 的照片 + 一点余量);缩略图:500KB(front end 已压到 400KB 内)
const MAX_FULL = 8 * 1024 * 1024;
const MAX_THUMB = 512 * 1024;

const KV_PREFIX = "gal:"; // 图库的 KV key 前缀,跟帖图 "img:" 分开

export async function onRequestPost({ request, env }) {
  if (!env.STORY_KV) return notReady("图片存储");
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("这是服主 / 管理员才能做的", 401);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return fail("表单没读上来,重新试一次");
  }

  const title = String(form.get("title") || "").trim().slice(0, 40);
  const fullFile = form.get("full");
  const thumbFile = form.get("thumb");

  if (!fullFile || !(fullFile instanceof File) || fullFile.size === 0)
    return fail("没拿到原图");
  if (!thumbFile || !(thumbFile instanceof File) || thumbFile.size === 0)
    return fail("没拿到缩略图");
  if (!title) return fail("给这张图起个名字吧");

  const fullType = (fullFile.type || "").split(";")[0].trim().toLowerCase();
  const thumbType = (thumbFile.type || "").split(";")[0].trim().toLowerCase();
  const fullExt = TYPES[fullType];
  const thumbExt = TYPES[thumbType];
  if (!fullExt) return fail("原图只收 JPG / PNG / WebP");
  if (!thumbExt) return fail("缩略图只收 JPG / PNG / WebP");

  if (fullFile.size > MAX_FULL) return fail("原图超过 8MB,请压到 5MB 左右再传", 413);

  const hex = randomHex(16);
  const fullKey = hex + ".full." + fullExt;
  const thumbKey = hex + ".thumb." + thumbExt;

  // 原图和缩略图分开存,读的时候按 key 后半段区分,不用整张下载就能判断
  await env.STORY_KV.put(KV_PREFIX + fullKey, fullFile, { metadata: { ct: fullType } });
  await env.STORY_KV.put(KV_PREFIX + thumbKey, thumbFile, { metadata: { ct: thumbType } });

  await env.DB.prepare(
    "INSERT INTO gallery (title, full_key, thumb_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(title, fullKey, thumbKey, me.id, Date.now())
    .run();

  return json({ ok: true, full: fullKey, thumb: thumbKey, title });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.full_key, g.thumb_key, g.created_at,
            u.username AS by_name
       FROM gallery g
       LEFT JOIN users u ON u.id = g.uploaded_by
      ORDER BY g.created_at DESC, g.id DESC`
  )
    .all();

  const items = (results || []).map((r) => ({
    id: r.id,
    title: r.title,
    full: r.full_key,
    thumb: r.thumb_key,
    by: r.by_name || "",
    created_at: r.created_at,
  }));

  return json({ ok: true, items });
}