/* ============================================================
   103 · 视频列表
   GET /api/videos?page=1&size=20   倒序分页(游客只看得到公开的)
   GET /api/videos?author=<id>      某个人发过的视频

   文件本体在 B2,这里只出元数据 + 作者 + 点赞 / 收藏 / 评论数,
   前端拿 file 去 /api/videos/file/<file> 取流。
   ============================================================ */

import { json, notReady, ensureSchema, currentUser, canViewClass } from "../_utils.js";
import { decorateVideos } from "../_videos.js";

const PAGE_SIZE = 20;
const MAX_SIZE = 60;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const size = Math.min(
    MAX_SIZE,
    Math.max(1, parseInt(url.searchParams.get("size") || String(PAGE_SIZE), 10) || PAGE_SIZE)
  );
  const authorId = parseInt(url.searchParams.get("author") || "0", 10) || 0;

  const me = await currentUser(request, env);
  // 「仅本班可见」的视频,未注册 / 未实名的普通用户直接看不到
  const visOnly = canViewClass(me) ? "" : " AND (visibility IS NULL OR visibility = 'public')";
  const where = (authorId ? "user_id = ?" : "1=1") + visOnly;
  const binds = authorId ? [authorId] : [];

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM videos WHERE ${where}`)
    .bind(...binds)
    .first();

  const { results } = await env.DB.prepare(
    `SELECT * FROM videos WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, size, (page - 1) * size)
    .all();

  const items = await decorateVideos(env.DB, results || [], me);

  return json({
    ok: true,
    total: totalRow ? Number(totalRow.n) || 0 : 0,
    page,
    size,
    items,
  });
}
