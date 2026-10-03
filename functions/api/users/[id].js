/* ============================================================
   103 · 单个成员
   DELETE /api/users/:id   彻底删掉一个账号(仅服主)

   删掉的是「账号」本身:
   - 会话一起清掉,那台设备立刻掉线
   - 用户名释放出来,可以再被注册
   - 但 TA 发过的留言保留,只把 user_id 置空,
     变成和以前一样的「老帖」,留言板内容不会凭空少一块
   服主账号删不了,自己也不能删自己(防止把唯一的管理权删没了)。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  ROLE_OWNER,
} from "../_utils.js";

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me || me.role !== ROLE_OWNER) return fail("只有服主能删除账号", 403);

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");
  if (id === me.id) return fail("不能删自己");

  const row = await env.DB.prepare("SELECT id, username, role FROM users WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("找不到这个成员", 404);
  if (row.role === ROLE_OWNER) return fail("服主账号不能删");

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("UPDATE posts SET user_id = NULL WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

  return json({ ok: true, id, name: row.username });
}
