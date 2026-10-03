/* ============================================================
   103 · 成员管理
   GET /api/users            成员列表(服主 / 管理员)
   PUT /api/users { id, role }  改角色(仅服主)

   角色只开放 member / admin 两档:
   服主是「一次性口令」换来的,不能在这儿转手,也不能被降级。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  ROLE_OWNER,
  ROLE_ADMIN,
} from "./_utils.js";

const PICK_ROLES = [ROLE_ADMIN, "member"];

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主和管理员能看成员列表", 403);

  const { results } = await env.DB.prepare(
    `SELECT id, username, role, avatar_key, signature, created_at
       FROM users
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id ASC`
  ).all();

  const users = (results || []).map((u) => ({
    id: u.id,
    name: u.username,
    role: u.role || "member",
    avatar: u.avatar_key || "",
    signature: u.signature || "",
    created_at: u.created_at,
  }));

  return json({ ok: true, users, me: me.id });
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me || me.role !== ROLE_OWNER) return fail("只有服主能改权限", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const id = parseInt(payload.id, 10) || 0;
  const role = String(payload.role || "");
  if (!id) return fail("成员编号不对");
  if (!PICK_ROLES.includes(role)) return fail("只能设为管理员或普通成员");

  const row = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first();
  if (!row) return fail("找不到这个成员", 404);
  if (row.role === ROLE_OWNER) return fail("服主不能被改权限");

  await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id).run();
  return json({ ok: true, id, role });
}
