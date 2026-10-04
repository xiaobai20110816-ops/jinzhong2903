/* ============================================================
   103 · 公开活跃榜
   GET /api/rank   谁在认真写、谁的帖子最热闹 —— 全班都能看

   全是聚合查询,不需要登录;被封禁的账号不进榜。
   名字同样走实名规则:服主 / 管理员 / 已实名的同学看到的是真名,
   其他人看到账号名。
   ============================================================ */

import { json, notReady, ensureSchema, currentUser, namedUser } from "./_utils.js";

/* 一行聚合结果 → 榜上要的样子(真名按 viewer 权限决定带不带) */
function person(r, viewer) {
  const u = namedUser(r, viewer);
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar || "",
    role: u.role || "member",
    verified: u.verified,
    real_name: u.real_name,
    display_name: u.display_name,
    cert_title: u.cert_title,
    cert_level: u.cert_level,
    n: Number(r.n) || 0,
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);

  const all = (sql, ...bind) =>
    env.DB.prepare(sql)
      .bind(...bind)
      .all()
      .then((r) => r.results || [])
      .catch(() => []);

  const [posters, liked, walled, hotRows, totalsRow] = await Promise.all([
    // 发主帖最多
    all(
      `SELECT u.id, u.username, u.avatar_key, u.role, u.real_name, u.verified, u.display_name, u.cert_title, u.cert_level, COUNT(*) AS n
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.parent_id IS NULL AND p.wall_id IS NULL AND IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 被点赞最多
    all(
      `SELECT u.id, u.username, u.avatar_key, u.role, u.real_name, u.verified, u.display_name, u.cert_title, u.cert_level, COUNT(*) AS n
         FROM profile_likes l JOIN users u ON u.id = l.to_id
        WHERE IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 主页收到留言最多
    all(
      `SELECT u.id, u.username, u.avatar_key, u.role, u.real_name, u.verified, u.display_name, u.cert_title, u.cert_level, COUNT(*) AS n
         FROM posts p JOIN users u ON u.id = p.wall_id
        WHERE p.wall_id IS NOT NULL AND IFNULL(u.banned, 0) = 0
        GROUP BY u.id
        ORDER BY n DESC, u.id ASC
        LIMIT 10`
    ),
    // 回复最热闹的主帖(顺手把楼主资料带出来,名字才能按权限显示)
    all(
      `SELECT p.id, p.name, p.body, p.created_at, COUNT(r.id) AS n,
              u.id AS a_id, u.username AS a_username, u.avatar_key AS a_avatar,
              u.role AS a_role, u.real_name AS a_real_name, u.verified AS a_verified,
              u.display_name AS a_display_name,
              u.cert_title AS a_cert_title, u.cert_level AS a_cert_level
         FROM posts p JOIN posts r ON r.parent_id = p.id
         LEFT JOIN users u ON u.id = p.user_id
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
    posters: posters.map((r) => person(r, me)),
    liked: liked.map((r) => person(r, me)),
    walled: walled.map((r) => person(r, me)),
    hot: hotRows.map((r) => {
      const author = r.a_id
        ? namedUser(
            {
              id: r.a_id,
              username: r.a_username,
              avatar_key: r.a_avatar,
              role: r.a_role,
              real_name: r.a_real_name,
              verified: r.a_verified,
              display_name: r.a_display_name,
              cert_title: r.a_cert_title,
              cert_level: r.a_cert_level,
            },
            me
          )
        : null;
      return {
        id: r.id,
        name: author ? author.real_name || author.name : r.name,
        display_name: author ? author.display_name : "",
        real_name: author && author.real_name ? author.real_name : "",
        verified: author && author.verified && author.real_name ? 1 : 0,
        cert_title: author ? author.cert_title : "",
        cert_level: author ? author.cert_level : "",
        excerpt: String(r.body || "").slice(0, 80),
        replies: Number(r.n) || 0,
        created_at: r.created_at,
      };
    }),
    totals: {
      members: (totalsRow && totalsRow.members) || 0,
      posts: (totalsRow && totalsRow.posts) || 0,
      replies: (totalsRow && totalsRow.replies) || 0,
      likes: (totalsRow && totalsRow.likes) || 0,
    },
  });
}
