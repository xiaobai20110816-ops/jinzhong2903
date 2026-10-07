/* ============================================================
   103 · 收藏 / 取消收藏一个表情
   POST /api/emojis/:id/fav   (toggle)
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能收藏表情", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("找不到这个表情", 404);

  const row = await env.DB.prepare("SELECT id FROM emojis WHERE id = ?").bind(id).first();
  if (!row) return fail("这个表情已经不在了", 404);

  const has = await env.DB.prepare(
    "SELECT 1 AS x FROM emoji_favs WHERE user_id = ? AND emoji_id = ?"
  )
    .bind(me.id, id)
    .first();

  if (has) {
    await env.DB.prepare("DELETE FROM emoji_favs WHERE user_id = ? AND emoji_id = ?")
      .bind(me.id, id)
      .run();
    return json({ ok: true, faved: 0 });
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO emoji_favs (user_id, emoji_id, created_at) VALUES (?, ?, ?)"
  )
    .bind(me.id, id, Date.now())
    .run();
  return json({ ok: true, faved: 1 });
}
