/* ============================================================
   103 · 学生风采
   GET /api/students   只列「实名审核通过」的账号

   学生风采推的是账号,真名由服主 / 管理员在后台慢慢审核:
   只有 verified = 1 的账号才出现在这里,没审核的账号不上榜。
   名字按实名规则下发 —— 服主 / 管理员 / 已实名的同学看到真名 + 蓝钩,
   其他人看到账号名。
   ============================================================ */

import { json, notReady, ensureSchema, currentUser, namedUser } from "./_utils.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);

  const { results } = await env.DB.prepare(
    `SELECT id, username, role, avatar_key, signature, real_name, verified, display_name, cert_title, cert_level
       FROM users
      WHERE IFNULL(verified, 0) = 1 AND IFNULL(banned, 0) = 0
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id ASC`
  ).all();

  const students = (results || []).map((u) => ({
    ...namedUser(u, me),
    signature: String(u.signature || ""),
  }));

  return json({ ok: true, students: students });
}
