/* ============================================================
   103 · 帖子点赞
   POST /api/posts/:id/like   点一下 = 赞,再点一下 = 取消(要登录)

   只对主帖有效:回复不单独计赞,免得一层层往下传。
   一人对一帖只有一条记录,靠 (post_id, user_id) 联合主键去重。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, notify } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能点赞", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  const post = await env.DB.prepare(
    "SELECT id, user_id, parent_id FROM posts WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!post) return fail("这条已经不在了", 404);
  if (post.parent_id) return fail("只能给主帖点赞");

  const mine = await env.DB.prepare(
    "SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?"
  )
    .bind(id, me.id)
    .first();

  let liked;
  if (mine) {
    await env.DB.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?")
      .bind(id, me.id)
      .run();
    liked = 0;
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(id, me.id, Date.now())
      .run();
    liked = 1;
    // 赞了别人的帖子 → 告诉 TA 一声(取消赞不重复通知,自己赞自己不通知)
    if (post.user_id && post.user_id !== me.id) {
      await notify(env.DB, {
        userId: post.user_id,
        actorId: me.id,
        type: "like",
        postId: id,
        excerpt: "",
      });
    }
  }

  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?")
    .bind(id)
    .first();

  return json({ ok: true, id, liked, likes: row ? Number(row.n) || 0 : 0 });
}
