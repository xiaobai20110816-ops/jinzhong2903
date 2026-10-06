/* ============================================================
   103 纪事 · 班级图库
   POST /api/gallery        上传一张图(原图 + 缩略图,multipart)
   GET  /api/gallery        图库列表(游客也能看缩略图)

   权限:
   - 实名认证通过的同学(verified=1)每人 30MB 额度,算原图总大小
   - 服主 / 管理员不限额度
   - 原图基本原样存 KV;缩略图由前端压小,不占额度
   下载走 /api/gallery/img/<key>,删除走 /api/gallery/:id。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  randomHex,
} from "../_utils.js";
import { b2Config, s3Put, b2ObjectName } from "../_b2.js";

const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// 实名同学的额度:30MB,按所有原图字节数累计(缩略图不算)
const MEMBER_QUOTA = 30 * 1024 * 1024;
// KV 单值上限是 25 MiB,传大图得留点余量,超出就是存不进去
const MAX_FULL = 24 * 1024 * 1024;
const MAX_THUMB = 512 * 1024;

const KV_PREFIX = "gal:"; // 图库的 KV key 前缀,跟帖图 "img:" 分开

// 上传时能选的画质档位(必须跟前端 LEVELS 的 key 一致)。
// 存下来是为了让下载时只给「这一档及其以下」—— 存进去的图已经压过了,
// 再让人下「更大」的档位没意义(压缩只会变小,不会凭空多出像素)。
const LEVEL_KEYS = ["orig", "xl", "md", "sm", "xs"];

/* 谁能传:服主 / 管理员 / 实名认证通过的同学 */
function canUpload(me) {
  return !!me && (isStaff(me) || me.verified === 1);
}

export async function onRequestPost({ request, env }) {
  if (!env.STORY_KV) return notReady("图片存储");
  if (!env.DB) return notReady("数据库");

  // 把整段包起来:任何一处抛异常,都给前端一个能读懂的错误,
  // 而不是裸的 HTTP 500(不然上传失败完全不知道为啥)
  try {
    await ensureSchema(env.DB);

    const me = await currentUser(request, env);
    if (!canUpload(me))
      return fail("实名认证通过的同学、管理员、服主才能上传照片", 401);

    // 配了 B2 就把原图丢 B2(KV 单值只有 25MiB,视频根本放不下);
    // 没配就还是老样子存 KV,一行都不用改
    const b2 = await b2Config(env, env.DB);

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return fail("表单没读上来,重新试一次");
    }

    const title = String(form.get("title") || "").trim().slice(0, 40);
    // 上传时选的画质档位;非法值一律当 orig(原样存)
    const rawLevel = String(form.get("level") || "").trim();
    const uploadLevel = LEVEL_KEYS.indexOf(rawLevel) >= 0 ? rawLevel : "orig";
    const fullFile = form.get("full");
    const thumbFile = form.get("thumb");

    // 用 instanceof Blob 判断:Blob 是各运行时的标准全局,比 instanceof File 稳得多
    // (个别环境里 File 可能不是直接暴露的全局,拿到就会 ReferenceError → 500)
    if (!(fullFile instanceof Blob) || fullFile.size === 0)
      return fail("没拿到原图");
    if (!(thumbFile instanceof Blob) || thumbFile.size === 0)
      return fail("没拿到缩略图");
    if (!title) return fail("给这张图起个名字吧");

    const fullType = (fullFile.type || "").split(";")[0].trim().toLowerCase();
    const thumbType = (thumbFile.type || "").split(";")[0].trim().toLowerCase();
    const fullExt = TYPES[fullType];
    const thumbExt = TYPES[thumbType];
    if (!fullExt) return fail("原图只收 JPG / PNG / WebP");
    if (!thumbExt) return fail("缩略图只收 JPG / PNG / WebP");

    // 单张超 24MB 存不进 KV(单值上限 25MiB)。走 B2 就没这个限制
    if (!b2.ready && fullFile.size > MAX_FULL)
      return fail("单张超过 24MB 存不下了（KV 单值上限），去后台「B2 配置」接上 B2 就能传大图", 413);
    if (thumbFile.size > MAX_THUMB) return fail("缩略图太大", 413);

    // 普通实名成员算额度;管理员 / 服主跳过
    if (!isStaff(me)) {
      const usedRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(full_size), 0) AS used FROM gallery WHERE uploaded_by = ?"
      )
        .bind(me.id)
        .first()
        .catch(() => null);
      const used = Number((usedRow && usedRow.used) || 0);
      if (used + fullFile.size > MEMBER_QUOTA) {
        const left = Math.max(0, MEMBER_QUOTA - used);
        return fail("你的 30MB 额度不够了（还差 " + fmtMB(fullFile.size - left) + "），先删几张旧的再传", 413);
      }
    }

    const hex = randomHex(16);
    // 存 B2 的原图带 "b2-" 前缀,读图/删除时一眼就知道该去哪个后端取
    const fullKey = (b2.ready ? "b2-" : "") + hex + ".full." + fullExt;
    const thumbKey = hex + ".thumb." + thumbExt;

    // KV.put 只认字符串 / ArrayBuffer / ArrayBufferView / ReadableStream,
    // 不能直接塞 File(Blob)。先读成 ArrayBuffer 再写,否则报
    // "KV put() accepts only strings, ArrayBuffers, ..."(upload.js 也是这么做的)。
    const fullBuf = await fullFile.arrayBuffer();
    const thumbBuf = await thumbFile.arrayBuffer();

    // 原图:配了 B2 就进 B2 的私有桶,读的时候由 /api/gallery/img 签名代理
    if (b2.ready) {
      await s3Put(b2, b2ObjectName(fullKey), fullBuf, fullType);
    } else {
      // 缩略图一律留在 KV,原图没接 B2 时也在这儿
      await env.STORY_KV.put(KV_PREFIX + fullKey, fullBuf, {
        metadata: { ct: fullType, size: fullFile.size },
      });
    }
    // 缩略图始终存 KV:体积小,读取快,不占 B2 的 10GB 免费额度
    await env.STORY_KV.put(KV_PREFIX + thumbKey, thumbBuf, {
      metadata: { ct: thumbType, size: thumbFile.size },
    });

    await env.DB.prepare(
      "INSERT INTO gallery (title, full_key, thumb_key, uploaded_by, full_size, upload_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(title, fullKey, thumbKey, me.id, fullFile.size, uploadLevel, Date.now())
      .run();

    return json({ ok: true, full: fullKey, thumb: thumbKey, title });
  } catch (e) {
    // 把真实原因带出去,前端会原样显示,便于判断到底是表结构/存储/还是别的
    return fail("上传出错：" + (e && e.message ? e.message : String(e)), 500);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.full_key, g.thumb_key, g.full_size, g.upload_level, g.created_at,
            g.uploaded_by, u.username AS by_name, u.display_name AS by_display
       FROM gallery g
       LEFT JOIN users u ON u.id = g.uploaded_by
      ORDER BY g.created_at DESC, g.id DESC`
  )
    .all();

  // 原图在 B2 的会带 "b2-" 前缀,读图时 Function 会自动去 B2 签名取流,
  // 前端只管用 /api/gallery/img/<full>,不用关心图到底存在哪个后端
  const items = (results || []).map((r) => ({
    id: r.id,
    title: r.title,
    full: r.full_key,
    thumb: r.thumb_key,
    full_size: Number(r.full_size) || 0,
    // 上传时选的档位:下载只给这一档及其以下
    level: LEVEL_KEYS.indexOf(String(r.upload_level || "")) >= 0 ? r.upload_level : "orig",
    // 展示上传者:优先昵称,没设就退回账号名
    by: (r.by_display && String(r.by_display).trim()) || r.by_name || "",
    by_id: r.uploaded_by || 0,
    created_at: r.created_at,
  }));

  // 顺手带上「我」的额度信息:前端拿来显示还剩多少,以及哪些图我能删
  const me = await currentUser(request, env).catch(() => null);
  let quota = null;
  if (me && canUpload(me)) {
    if (isStaff(me)) {
      quota = { limit: -1, used: 0, unlimited: true };
    } else {
      const usedRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(full_size), 0) AS used FROM gallery WHERE uploaded_by = ?"
      )
        .bind(me.id)
        .first()
        .catch(() => null);
      quota = {
        limit: MEMBER_QUOTA,
        used: Number((usedRow && usedRow.used) || 0),
        unlimited: false,
      };
    }
  }

  return json({
    ok: true,
    items,
    me: me ? { id: me.id, role: me.role, verified: me.verified } : null,
    quota,
  });
}

function fmtMB(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? Math.round(mb) + "MB" : mb.toFixed(1) + "MB";
}
