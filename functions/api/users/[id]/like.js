/* ============================================================
   103 · 个人主页点赞
   POST /api/users/:id/like   点一下 = 赞,再点一下 = 取消(要登录)

   一人对一人只有一条记录,靠 (from_id, to_id) 联合主键去重。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, classGate, notify } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");
  if (id === me.id) return fail("不能给自己点赞");

  const target = await env.DB.prepare("SELECT id, banned FROM users WHERE id = ?")
    .bind(id)
    .first();
  if (!target || target.banned) return fail("找不到这个人", 404);

  const mine = await env.DB.prepare(
    "SELECT 1 AS x FROM profile_likes WHERE from_id = ? AND to_id = ?"
  )
    .bind(me.id, id)
    .first();

  let liked;
  if (mine) {
    await env.DB.prepare("DELETE FROM profile_likes WHERE from_id = ? AND to_id = ?")
      .bind(me.id, id)
      .run();
    liked = 0;
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO profile_likes (from_id, to_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(me.id, id, Date.now())
      .run();
    liked = 1;
    // 赞了别人 → 告诉 TA 一声(取消赞不重复通知)
    await notify(env.DB, { userId: id, actorId: me.id, type: "like", excerpt: "" });
  }

  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM profile_likes WHERE to_id = ?")
    .bind(id)
    .first();

  return json({ ok: true, id, liked, likes: row ? row.n : 0 });
}
