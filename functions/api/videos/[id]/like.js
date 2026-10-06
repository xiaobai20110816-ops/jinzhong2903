/* ============================================================
   103 · 视频点赞
   POST /api/videos/:id/like   点一下 = 赞,再点一下 = 取消(要登录)

   一人一视频只有一条记录,(video_id, user_id) 联合主键去重。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, notify } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能点赞", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("视频编号不对");

  const video = await env.DB.prepare("SELECT id, user_id FROM videos WHERE id = ?")
    .bind(id)
    .first();
  if (!video) return fail("这个视频已经不在了", 404);

  const mine = await env.DB.prepare(
    "SELECT 1 AS x FROM video_likes WHERE video_id = ? AND user_id = ?"
  )
    .bind(id, me.id)
    .first();

  let liked;
  if (mine) {
    await env.DB.prepare("DELETE FROM video_likes WHERE video_id = ? AND user_id = ?")
      .bind(id, me.id)
      .run();
    liked = 0;
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO video_likes (video_id, user_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(id, me.id, Date.now())
      .run();
    liked = 1;
    // 赞了别人的视频 → 告诉 TA 一声(取消赞不重复通知,自己赞自己不通知)
    await notify(env.DB, {
      userId: video.user_id,
      actorId: me.id,
      type: "vlike",
      videoId: id,
      excerpt: "",
    });
  }

  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM video_likes WHERE video_id = ?")
    .bind(id)
    .first();

  return json({ ok: true, id, liked, likes: row ? Number(row.n) || 0 : 0 });
}
