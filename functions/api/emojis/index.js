/* ============================================================
   103 · 表情包
   GET  /api/emojis   全部自制表情 + 我收藏的 + 我最近用过的
   POST /api/emojis   新建一个(先走 /api/upload 拿到图片 key 再提交)

   默认表情是 unicode 字符,不用入库也不用接口;这里只管
   「班级自制 / 同学上传」的那些图片表情 —— 图存在 KV,表里只记 name + key。
   正文里出现 [emoji:名字] 就渲染成这张图。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff, IMAGE_KEY_RE } from "../_utils.js";

const MAX_NAME = 12;
const MAX_TOTAL = 300; // 全班合起来最多这么多张,防着被当免费图床

/* 名字规则:去掉换行和方括号冒号(它们会把 [emoji:名字] 的语法撑破),最长 12 字 */
export function cleanEmojiName(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[[\]:]/g, "")
    .trim()
    .slice(0, MAX_NAME);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);

  // 表情列表是公开的:游客也要能把帖子正文里的 [emoji:xx] 渲染出来
  const { results } = await env.DB.prepare(
    "SELECT id, name, key, created_at FROM emojis ORDER BY created_at ASC, id ASC"
  )
    .all()
    .catch(() => ({ results: [] }));
  const list = (results || []).map((r) => ({
    id: r.id,
    name: r.name,
    key: r.key,
    created_at: r.created_at,
  }));

  // 收藏和「最近使用」是各人各一份,没登录就不给
  let favs = [];
  let recent = [];
  if (me) {
    const f = await env.DB.prepare("SELECT emoji_id FROM emoji_favs WHERE user_id = ?")
      .bind(me.id)
      .all()
      .catch(() => ({ results: [] }));
    favs = (f.results || []).map((r) => r.emoji_id);

    const u = await env.DB.prepare(
      `SELECT e.id, e.name, e.key
         FROM emoji_usage s JOIN emojis e ON e.id = s.emoji_id
        WHERE s.user_id = ?
        ORDER BY s.last_used DESC
        LIMIT 12`
    )
      .bind(me.id)
      .all()
      .catch(() => ({ results: [] }));
    recent = (u.results || []).map((r) => ({ id: r.id, name: r.name, key: r.key }));
  }

  return json({ ok: true, list, favs, recent });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能上传表情", 401);
  // 和传图库照片一个门槛:实名过的同学才给传,免得被人乱塞
  if (!isStaff(me) && Number(me.verified) !== 1) {
    return fail("实名认证通过后才能上传自制表情", 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const name = cleanEmojiName(payload && payload.name);
  const key = String((payload && payload.key) || "").trim();
  if (!name) return fail("给这个表情起个名字吧");
  if (!IMAGE_KEY_RE.test(key)) return fail("表情图没传上来，重试一次");

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM emojis").first().catch(() => null);
  if (total && Number(total.n) >= MAX_TOTAL) return fail("自制表情已经很多啦，先删几张再加");

  const now = Date.now();
  try {
    const res = await env.DB.prepare(
      "INSERT INTO emojis (name, key, uploader_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(name, key, me.id, now)
      .run();
    return json({ ok: true, emoji: { id: res.meta.last_row_id, name: name, key: key, created_at: now } });
  } catch (e) {
    return fail("已经有同名表情了，换个名字吧");
  }
}
