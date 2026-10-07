/* ============================================================
   103 · 你可能认识的人
   GET /api/messages/suggest   给「私信」页左栏推荐几个还没聊过的同学

   挑人规则:
   · 排除自己、排除被封禁的、排除「已经和我有会话」的人(已经有会话就直接在列表里了)
   · 共同好友多的排前面 —— 共同好友 = 我私信过的人 ∩ TA 私信过的人
   · 一样多时,新注册的排前面
   返回 { ok, list: [{ ...用户, reason }] },reason 是给前端显示的一句话。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, namedUser } from "../_utils.js";

const LIMIT = 12;

// 我的对端:和我发过消息的每个人(发的 + 收的都算)
const PEERS_SQL = `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS peer
                     FROM messages WHERE from_id = ? OR to_id = ?`;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  /* 一条 SQL 算完「共同好友数」:对每个候选账号,数一数我私信过的人里
     有多少个也和 TA 私信过。外层 WHERE 先过滤掉不该出现的人,
     内层子查询各自独立,不会随候选人数叠加成 N+1 次往返。 */
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.avatar_key, u.role, u.real_name, u.verified,
            u.display_name, u.cert_title, u.cert_level,
            (SELECT COUNT(DISTINCT CASE WHEN m2.from_id = u.id THEN m2.to_id ELSE m2.from_id END)
               FROM messages m2
              WHERE (m2.from_id = u.id OR m2.to_id = u.id)
                AND CASE WHEN m2.from_id = u.id THEN m2.to_id ELSE m2.from_id END IN (${PEERS_SQL})
            ) AS common
       FROM users u
      WHERE u.id <> ?
        AND (u.banned IS NULL OR u.banned = 0)
        AND u.id NOT IN (${PEERS_SQL})
      ORDER BY common DESC, u.created_at DESC
      LIMIT ?`
  )
    .bind(me.id, me.id, me.id, me.id, me.id, me.id, me.id, LIMIT)
    .all()
    .catch(() => ({ results: [] }));

  const list = (results || []).map((row) => {
    const u = namedUser(row, me);
    const n = Number(row.common) || 0;
    u.reason = n > 0 ? `你和 TA 有 ${n} 位共同好友` : "103 同班同学";
    return u;
  });

  return json({ ok: true, list: list });
}
