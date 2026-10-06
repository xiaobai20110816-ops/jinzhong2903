/* ============================================================
   103 · 视频上传
   POST /api/videos/upload?title=&body=&cover=&dur=&w=&h=&vis=
   body = 视频二进制(裸流,不是 multipart —— 大文件走表单要整段解析,更吃内存)

   为什么视频非得走 B2:KV 单值上限 25MiB,一个手机视频都放不下。
   库里只记元数据(b2_key / 封面 / 时长 / 大小),文件本体在 B2 私有桶,
   读的时候由 /api/videos/file 签名代理,顺手写边缘缓存。

   上限 80MB:Cloudflare Functions 的请求体上限约 100MB,
   而且读成 ArrayBuffer 会占内存,留出余量更稳。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  randomHex,
  IMAGE_KEY_RE,
} from "../_utils.js";
import { b2Config, s3Put, videoObjectName } from "../_b2.js";

const TYPES = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
};

const MAX_BYTES = 80 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  // 没接 B2 就直说:视频没别的地方可放
  const b2 = await b2Config(env, env.DB);
  if (!b2.ready)
    return fail("视频要存到 B2，请先在管理后台「B2 配置」里接上再传", 503);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能上传视频", 401);
  if (!isStaff(me) && me.verified !== 1)
    return fail("实名认证通过的同学、管理员、服主才能上传视频", 403);

  const url = new URL(request.url);
  const title = String(url.searchParams.get("title") || "").trim().slice(0, 60);
  const body = String(url.searchParams.get("body") || "").trim().slice(0, 2000);
  const cover = String(url.searchParams.get("cover") || "").trim();
  const duration = Math.max(0, parseFloat(url.searchParams.get("dur") || "0") || 0);
  const width = Math.max(0, parseInt(url.searchParams.get("w") || "0", 10) || 0);
  const height = Math.max(0, parseInt(url.searchParams.get("h") || "0", 10) || 0);
  const visibility = url.searchParams.get("vis") === "class" ? "class" : "public";

  if (!title) return fail("给这个视频起个标题吧");
  if (cover && !IMAGE_KEY_RE.test(cover)) return fail("封面图不对，重新选一次");

  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return fail("只收 MP4 / WebM / MOV 视频");

  const declared = parseInt(request.headers.get("content-length") || "0", 10) || 0;
  if (declared && declared > MAX_BYTES) return fail(tooBig(), 413);

  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (e) {
    return fail("视频没读上来，网络断了一下，重新传一次");
  }
  if (!buf.byteLength) return fail("这个视频是空的");
  if (buf.byteLength > MAX_BYTES) return fail(tooBig(), 413);

  const key = "b2v-" + randomHex(16) + "." + ext;
  try {
    await s3Put(b2, videoObjectName(key), buf, type);
  } catch (e) {
    return fail("传到 B2 失败了：" + (e && e.message ? e.message : String(e)), 502);
  }

  const res = await env.DB.prepare(
    `INSERT INTO videos (user_id, title, body, b2_key, cover_key, mime, size, duration, width, height, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      me.id,
      title,
      body,
      key,
      cover,
      type,
      buf.byteLength,
      duration,
      width,
      height,
      visibility,
      Date.now()
    )
    .run();

  return json({ ok: true, id: res.meta.last_row_id, key });
}

function tooBig() {
  return "视频超过 " + Math.round(MAX_BYTES / 1048576) + "MB，先剪短或压一下再传";
}
