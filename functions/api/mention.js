/* ============================================================
   103 · @ 候选
   GET /api/mention?q=<关键词>
   返回 { ok, list: [{ id, name, username, avatar, verified, followed }] }

   排序就是「关注的人先跳出来」:followed DESC → 实名优先 → 编号。
   没写关键词(刚打出一个 @)时,也先给关注的人。
   真名只对「已审核通过」的人公开,没审核的只按昵称 / 账号名匹配。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  displayNameOf,
} from "./_utils.js";

const LIMIT = 8;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能 @ 同学", 401);

  const q = String(new URL(request.url).searchParams.get("q") || "")
    .trim()
    .slice(0, 20);
  const like = "%" + q + "%";

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.real_name, u.avatar_key, u.verified,
            CASE WHEN f.follower_id IS NULL THEN 0 ELSE 1 END AS followed
       FROM users u
       LEFT JOIN follows f ON f.followee_id = u.id AND f.follower_id = ?
      WHERE IFNULL(u.banned, 0) = 0 AND u.role <> 'ai' AND u.id <> ?
        AND (
          ? = ''
          OR u.username LIKE ?
          OR IFNULL(u.display_name, '') LIKE ?
          OR (u.verified = 1 AND IFNULL(u.real_name, '') LIKE ?)
        )
      ORDER BY followed DESC, u.verified DESC, u.id ASC
      LIMIT ?`
  )
    .bind(me.id, me.id, q, like, like, like, LIMIT)
    .all()
    .catch(() => ({ results: [] }));

  return json({
    ok: true,
    list: (results || []).map((r) => ({
      id: r.id,
      name: displayNameOf(r),
      username: r.username,
      avatar: String(r.avatar_key || ""),
      verified: r.verified ? 1 : 0,
      followed: r.followed ? 1 : 0,
    })),
  });
}
