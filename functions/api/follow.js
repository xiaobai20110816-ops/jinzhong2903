/* ============================================================
   103 · 关注
   GET  /api/follow            我关注了谁(登录后才有,给 @ 列表当候选)
   GET  /api/follow?of=<id>    某个人的关注数 / 粉丝数 / 我有没有关注 TA
   POST /api/follow            关注或取关 { user, follow: true|false }

   关注是单向的:你关注我,不代表我关注你。表里一行就是一条关系。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  displayNameOf,
  notify,
} from "./_utils.js";

const MAX_LIST = 100;

/* 一条关系的计数:关注了几个人 / 被几个人关注 */
async function countsOf(db, id) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following,
         (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS followers`
    )
    .bind(id, id)
    .first()
    .catch(() => null);
  return {
    following: Number(row && row.following) || 0,
    followers: Number(row && row.followers) || 0,
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const of = parseInt(url.searchParams.get("of") || "0", 10) || 0;
  const me = await currentUser(request, env);

  // 看某个人的主页:只回数字,不列名单(名单是隐私)
  if (of) {
    const target = await env.DB.prepare("SELECT id, banned FROM users WHERE id = ?")
      .bind(of)
      .first();
    if (!target || (target.banned && !me)) return fail("找不到这个人", 404);

    const counts = await countsOf(env.DB, of);
    let iFollow = 0;
    if (me) {
      const row = await env.DB.prepare(
        "SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?"
      )
        .bind(me.id, of)
        .first();
      iFollow = row ? 1 : 0;
    }
    return json({ ok: true, id: of, i_follow: iFollow, ...counts });
  }

  // 不带参数:@ 候选列表。没登录就空着,前端只用它来排序
  if (!me) return json({ ok: true, list: [] });

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.real_name, u.avatar_key, u.verified
       FROM follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? AND IFNULL(u.banned, 0) = 0
      ORDER BY f.created_at DESC
      LIMIT ?`
  )
    .bind(me.id, MAX_LIST)
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
    })),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能关注", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const targetId = parseInt((payload && payload.user) || 0, 10) || 0;
  if (!targetId) return fail("没说关注谁");
  if (targetId === me.id) return fail("不用关注自己");

  const target = await env.DB.prepare("SELECT id, banned, role FROM users WHERE id = ?")
    .bind(targetId)
    .first();
  if (!target || target.banned || target.role === "ai") return fail("找不到这个人", 404);

  const now = Date.now();
  // follow 不传就是「切换」,传了就按传的来(多端同时点也不会翻来覆去)
  let want = payload && payload.follow;
  if (want === undefined) {
    const cur = await env.DB.prepare(
      "SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?"
    )
      .bind(me.id, targetId)
      .first();
    want = !cur;
  }

  if (want) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(me.id, targetId, now)
      .run();
    // 只在这一行真的新插入时通知,反复关注 / 取关不会刷屏
    const notifyRow = await env.DB.prepare(
      "SELECT created_at FROM follows WHERE follower_id = ? AND followee_id = ?"
    )
      .bind(me.id, targetId)
      .first();
    if (notifyRow && Number(notifyRow.created_at) === now) {
      await notify(env.DB, {
        userId: targetId,
        actorId: me.id,
        type: "follow",
        excerpt: "关注了你",
      });
    }
  } else {
    await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?")
      .bind(me.id, targetId)
      .run();
  }

  const counts = await countsOf(env.DB, targetId);
  return json({ ok: true, id: targetId, i_follow: want ? 1 : 0, ...counts });
}
