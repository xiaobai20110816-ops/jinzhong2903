/* ============================================================
   103 · 视频收藏
   POST /api/videos/:id/fav   点一下 = 收藏,再点一下 = 取消(要登录)

   和点赞一样是一人一条;(video_id, user_id) 联合主键去重。
   收藏不发通知 —— 自己悄悄存起来的东西,没必要惊动作者。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, classGate } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const id = parseInt(params.id, 10);
  if (!id) return fail("视频编号不对");

  const video = await env.DB.prepare("SELECT id FROM videos WHERE id = ?").bind(id).first();
  if (!video) return fail("这个视频已经不在了", 404);

  const mine = await env.DB.prepare(
    "SELECT 1 AS x FROM video_favs WHERE video_id = ? AND user_id = ?"
  )
    .bind(id, me.id)
    .first();

  let faved;
  if (mine) {
    await env.DB.prepare("DELETE FROM video_favs WHERE video_id = ? AND user_id = ?")
      .bind(id, me.id)
      .run();
    faved = 0;
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO video_favs (video_id, user_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(id, me.id, Date.now())
      .run();
    faved = 1;
  }

  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM video_favs WHERE video_id = ?")
    .bind(id)
    .first();

  return json({ ok: true, id, faved, favs: row ? Number(row.n) || 0 : 0 });
}
