/* ============================================================
   103 · 记一次「用过这个表情」
   POST /api/emojis/:id/use

   前端插入表情时顺手报一次,用来排「最近使用」。
   每次都用 INSERT OR REPLACE 更新 last_used,不保存历史明细。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser } from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("找不到这个表情", 404);

  const row = await env.DB.prepare("SELECT id FROM emojis WHERE id = ?").bind(id).first();
  if (!row) return fail("这个表情已经不在了", 404);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO emoji_usage (user_id, emoji_id, uses, last_used) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, emoji_id) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used`
  )
    .bind(me.id, id, now)
    .run();

  return json({ ok: true });
}
