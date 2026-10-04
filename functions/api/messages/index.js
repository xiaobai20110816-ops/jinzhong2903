/* ============================================================
   103 · 私信会话列表
   GET /api/messages   取「我」的所有一对一会话

   只列和「我」有来往的对端,按最后一条消息时间倒序。
   对端被封禁也照常列出 —— 历史记录不能凭空消失;
   但它不会再作为新会话入口(POST 那边会拦住)。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, namedUser } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const unreadRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND read = 0"
  )
    .bind(me.id)
    .first();
  const unread = unreadRow ? Number(unreadRow.n) || 0 : 0;

  // 对端 = 这条消息的「另一端」:我发的看 to_id,收到的看 from_id
  const PEER = "CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END";

  /* 「每个对端的最后一条」用 MAX(id) 定位:id 自增且严格单调,
     比 MAX(created_at) 稳(同一毫秒并发也不会取错)。
     display_name 必须一起 SELECT,否则 namedUser 里昵称就是空的。 */
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.from_id, m.body, m.created_at, ${PEER} AS peer_id,
            u.id AS uid, u.username, u.avatar_key, u.role, u.real_name, u.verified,
            u.display_name, u.cert_title, u.cert_level
       FROM messages m
       JOIN users u ON u.id = ${PEER}
      WHERE m.id IN (
            SELECT MAX(id) FROM messages
             WHERE from_id = ? OR to_id = ?
             GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)
      ORDER BY m.created_at DESC, m.id DESC`
  )
    .bind(me.id, me.id, me.id, me.id, me.id)
    .all();

  // 每个对端有多少条未读:一次聚合,别在对端循环里逐条查库
  const { results: unreadRows } = await env.DB.prepare(
    `SELECT from_id AS peer_id, COUNT(*) AS n
       FROM messages
      WHERE to_id = ? AND read = 0
      GROUP BY from_id`
  )
    .bind(me.id)
    .all();
  const unreadBy = new Map((unreadRows || []).map((r) => [r.peer_id, Number(r.n) || 0]));

  const chats = (results || []).map((row) => ({
    peer: namedUser(
      {
        id: row.uid,
        username: row.username,
        avatar_key: row.avatar_key,
        role: row.role,
        real_name: row.real_name,
        verified: row.verified,
        display_name: row.display_name,
        cert_title: row.cert_title,
        cert_level: row.cert_level,
      },
      me
    ),
    last: { body: row.body, created_at: row.created_at, mine: row.from_id === me.id ? 1 : 0 },
    unread: unreadBy.get(row.peer_id) || 0,
  }));

  return json({ ok: true, unread, chats });
}
