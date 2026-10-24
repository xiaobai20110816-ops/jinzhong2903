/* ============================================================
   103 · 服主查看某人的私聊记录
   GET /api/messages/:uid/all                TA 参与过的所有会话
   GET /api/messages/:uid/all?peer=<对端id>  TA 与某个对端的完整对话

   仅服主可用。这里绝不改 read —— 服主看记录不能把人家真实的未读状态抹掉。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, namedUser, ROLE_OWNER } from "../../_utils.js";

const PAGE = 50;

const USER_COLS =
  "id, username, avatar_key, role, real_name, verified, display_name, cert_title, cert_level";

async function loadUser(db, id) {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first();
}

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me || me.role !== ROLE_OWNER) return fail("只有服主能查看私聊记录", 403);

  const uid = parseInt(params.uid, 10);
  if (!uid) return fail("成员编号不对");

  const row = await loadUser(env.DB, uid);
  if (!row) return fail("找不到这个人", 404);
  const user = namedUser(row, me);

  const url = new URL(request.url);
  const peerId = parseInt(url.searchParams.get("peer") || "0", 10) || 0;

  // ---- 指定对端:返回这段对话(纯读,不碰 read) ----
  if (peerId) {
    const peerRow = await loadUser(env.DB, peerId);
    if (!peerRow) return fail("找不到这个对端", 404);

    const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;
    const where = before
      ? "((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id < ?"
      : "(from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)";
    const binds = before
      ? [uid, peerId, peerId, uid, before, PAGE + 1]
      : [uid, peerId, peerId, uid, PAGE + 1];
    const { results } = await env.DB.prepare(
      `SELECT id, from_id, body, created_at FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`
    )
      .bind(...binds)
      .all();

    const rows = results || [];
    const hasMore = rows.length > PAGE;
    const slice = hasMore ? rows.slice(0, PAGE) : rows;
    slice.reverse();

    return json({
      ok: true,
      user: user,
      peer: namedUser(peerRow, me),
      // mine 相对「被查看的人」,纯展示用
      items: slice.map((r) => ({
        id: r.id,
        body: r.body,
        created_at: r.created_at,
        mine: r.from_id === uid ? 1 : 0,
      })),
      hasMore,
    });
  }

  // ---- 不带参数:列出 uid 参与过的所有会话 ----
  const PEER = "CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END";
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
    .bind(uid, uid, uid, uid, uid)
    .all();

  // 每段会话的总条数,一次聚合
  const { results: countRows } = await env.DB.prepare(
    `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS peer_id, COUNT(*) AS n
       FROM messages WHERE from_id = ? OR to_id = ?
      GROUP BY peer_id`
  )
    .bind(uid, uid, uid)
    .all();
  const countBy = new Map((countRows || []).map((r) => [r.peer_id, Number(r.n) || 0]));

  const chats = (results || []).map((r) => ({
    peer: namedUser(
      {
        id: r.uid,
        username: r.username,
        avatar_key: r.avatar_key,
        role: r.role,
        real_name: r.real_name,
        verified: r.verified,
        display_name: r.display_name,
        cert_title: r.cert_title,
        cert_level: r.cert_level,
      },
      me
    ),
    // 最后一条 + 这是不是「被查看的人」发的
    last: { body: r.body, created_at: r.created_at, mine: r.from_id === uid ? 1 : 0 },
    count: countBy.get(r.peer_id) || 0,
  }));

  return json({ ok: true, user: user, chats });
}
