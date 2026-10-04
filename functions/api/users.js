/* ============================================================
   103 · 成员管理
   GET /api/users   成员列表(服主 / 管理员)

   列表把每个人的账号信息一次摊开:角色、签名、注册时间、发帖数、封禁状态。
   改角色 / 改名 / 重置密码 / 封禁解封 / 删除都在 /api/users/:id 上,
   全部仅服主可用,这里只读。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff } from "./_utils.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主和管理员能看成员列表", 403);

  const { results } = await env.DB.prepare(
    `SELECT id, username, role, avatar_key, signature, banned, real_name, verified, cert_title, created_at
       FROM users
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id ASC`
  ).all();

  // 发帖数一次聚合算完,不逐个成员查库
  const counts = new Map();
  const { results: agg } = await env.DB.prepare(
    "SELECT user_id, COUNT(*) AS n FROM posts WHERE user_id IS NOT NULL GROUP BY user_id"
  ).all();
  for (const r of agg || []) counts.set(r.user_id, r.n);

  // 这个接口只有服主 / 管理员进得来(上面刚挡过),真名可以直接给
  const users = (results || []).map((u) => ({
    id: u.id,
    name: u.username,
    role: u.role || "member",
    avatar: u.avatar_key || "",
    signature: u.signature || "",
    banned: u.banned ? 1 : 0,
    real_name: String(u.real_name == null ? "" : u.real_name).trim(),
    verified: u.verified ? 1 : 0,
    cert_title: String(u.cert_title == null ? "" : u.cert_title).trim(),
    created_at: u.created_at,
    posts: counts.get(u.id) || 0,
  }));

  return json({ ok: true, users, me: me.id });
}
