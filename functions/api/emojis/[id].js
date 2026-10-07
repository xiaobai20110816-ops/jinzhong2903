/* ============================================================
   103 · 删掉一个自制表情
   DELETE /api/emojis/:id   上传者本人,或者服主 / 管理员

   顺手把收藏和「最近使用」里的记录一起清掉,不留孤儿行。
   KV 里的图片不用管:没人再引用它,留着也不碍事。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff } from "../_utils.js";

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能操作", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("找不到这个表情", 404);

  const row = await env.DB.prepare("SELECT id, uploader_id FROM emojis WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这个表情已经不在了", 404);
  if (!isStaff(me) && row.uploader_id !== me.id) return fail("只能删自己上传的表情", 403);

  await env.DB.prepare("DELETE FROM emoji_favs WHERE emoji_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM emoji_usage WHERE emoji_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM emojis WHERE id = ?").bind(id).run();

  return json({ ok: true, id: id });
}
