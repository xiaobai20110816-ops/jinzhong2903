/* ============================================================
   103 · 互动通知
   GET  /api/notifications          取最近 40 条 + 未读数
   POST /api/notifications          标记已读({all:true} 或 {id})

   通知在三个地方产生:回复帖子、在别人主页留言、给别人的主页点赞,
   都是「别人对我」的动作;自己对自己做的不记。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser } from "./_utils.js";

const MAX = 40;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  // 没登录就是「没有通知」,不报错,免得前端还要专门处理
  if (!me) return json({ ok: true, unread: 0, items: [] });

  const { results } = await env.DB.prepare(
    `SELECT n.id, n.type, n.post_id, n.wall_id, n.excerpt, n.read, n.created_at,
            u.id AS actor_id, u.username AS actor_name,
            u.avatar_key AS actor_avatar, u.role AS actor_role
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?`
  )
    .bind(me.id, MAX)
    .all();

  let unread = 0;
  const items = (results || []).map((r) => {
    if (!r.read) unread++;
    return {
      id: r.id,
      type: r.type,
      post_id: r.post_id || 0,
      wall_id: r.wall_id || 0,
      excerpt: r.excerpt || "",
      read: r.read ? 1 : 0,
      created_at: r.created_at,
      actor: r.actor_id
        ? {
            id: r.actor_id,
            name: r.actor_name,
            avatar: r.actor_avatar || "",
            role: r.actor_role || "member",
          }
        : null,
    };
  });

  return json({ ok: true, unread: unread, items: items });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能操作", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    payload = {};
  }

  if (payload.all) {
    await env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
      .bind(me.id)
      .run();
    return json({ ok: true, unread: 0 });
  }

  const id = parseInt(payload.id, 10) || 0;
  if (!id) return fail("没说是哪一条");
  await env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?")
    .bind(id, me.id)
    .run();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0"
  )
    .bind(me.id)
    .first();
  return json({ ok: true, unread: row ? row.n : 0 });
}
