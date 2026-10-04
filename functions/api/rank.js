/* ============================================================
   103 · 公开活跃榜
   GET /api/rank   谁在认真写、谁的帖子最热闹 —— 全班都能看

   全是聚合查询,不需要登录;被封禁的账号不进榜。
   ============================================================ */

import { json, notReady, ensureSchema } from "./_utils.js";

/* 一行 users 记录 → 榜上要的样子 */
function person(r) {
  return {
    id: r.id,
    name: r.name,
    avatar: r.avatar || "",
    role: r.role || "member",
    n: Number(r.n) || 0,
  };
}

export async function onRequestGet({ env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const all = (sql, ...bind) =>
    env.DB.prepare(sql)
      .bind(...bind)
      .all()
      .then((r) => r.results || [])
      .catch(() => []);

  const [posters, liked, walled, hotRows, totalsRow] = await Promise.all([
    // 发主帖最多
    all(
      `SELECT u.id, u.username AS name, u.avatar_key AS avatar, u.role, COUNT(*) AS n
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.parent_id IS NULL AND p.wall_id IS NULL AND IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 被点赞最多
    all(
      `SELECT u.id, u.username AS name, u.avatar_key AS avatar, u.role, COUNT(*) AS n
         FROM profile_likes l JOIN users u ON u.id = l.to_id
        WHERE IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 主页收到留言最多
    all(
      `SELECT u.id, u.username AS name, u.avatar_key AS avatar, u.role, COUNT(*) AS n
         FROM posts p JOIN users u ON u.id = p.wall_id
        WHERE p.wall_id IS NOT NULL AND IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 回复最热闹的主帖
    all(
      `SELECT p.id, p.name, p.body, p.created_at, COUNT(r.id) AS n
         FROM posts p JOIN posts r ON r.parent_id = p.id
        WHERE p.parent_id IS NULL AND p.wall_id IS NULL
        GROUP BY p.id
        ORDER BY n DESC, p.created_at DESC
        LIMIT 8`
    ),
    env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE IFNULL(banned, 0) = 0) AS members,
           (SELECT COUNT(*) FROM posts WHERE parent_id IS NULL AND wall_id IS NULL) AS posts,
           (SELECT COUNT(*) FROM posts WHERE parent_id IS NOT NULL) AS replies,
           (SELECT COUNT(*) FROM profile_likes) AS likes`
      )
      .first()
      .catch(() => null),
  ]);

  return json({
    ok: true,
    posters: posters.map(person),
    liked: liked.map(person),
    walled: walled.map(person),
    hot: hotRows.map((r) => ({
      id: r.id,
      name: r.name,
      excerpt: String(r.body || "").slice(0, 80),
      replies: Number(r.n) || 0,
      created_at: r.created_at,
    })),
    totals: {
      members: (totalsRow && totalsRow.members) || 0,
      posts: (totalsRow && totalsRow.posts) || 0,
      replies: (totalsRow && totalsRow.replies) || 0,
      likes: (totalsRow && totalsRow.likes) || 0,
    },
  });
}
