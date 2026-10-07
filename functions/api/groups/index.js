/* ============================================================
   103 · 群聊
   GET  /api/groups   我加入的群(带最后一条消息、成员数、未读数)
   POST /api/groups   建一个群 { name, members: [uid, ...] }

   群和一对一会话是两套东西:
   · 一对一会话复用 messages 表,按 id 取每个对端的最后一条
   · 群消息单独一张 group_messages 表,未读靠 group_members.last_read_id
   前端把两边合并成一条「会话列表」显示,所以顺序交给前端排。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, namedUser, loadAuthors } from "../_utils.js";

const MAX_NAME = 20;
const MAX_MEMBERS = 30;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.name, g.owner_id, g.created_at, m.last_read_id
       FROM groups g
       JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
      ORDER BY g.created_at DESC`
  )
    .bind(me.id)
    .all()
    .catch(() => ({ results: [] }));

  const list = groups || [];
  if (!list.length) return json({ ok: true, groups: [] });

  const ids = list.map((g) => g.id);
  const holes = ids.map(() => "?").join(",");

  // 每个群的最后一条:和私信一个套路,用 MAX(id) 定位
  const { results: lastRows } = await env.DB.prepare(
    `SELECT group_id, body, from_id, created_at
       FROM group_messages
      WHERE id IN (SELECT MAX(id) FROM group_messages WHERE group_id IN (${holes}) GROUP BY group_id)`
  )
    .bind(...ids)
    .all()
    .catch(() => ({ results: [] }));
  const lastBy = new Map((lastRows || []).map((r) => [r.group_id, r]));

  // 每个群的未读数:别人发的、比「我读到的那条」更新的
  const { results: unreadRows } = await env.DB.prepare(
    `SELECT gm.group_id, COUNT(*) AS n
       FROM group_messages gm
       JOIN group_members m ON m.group_id = gm.group_id AND m.user_id = ?
      WHERE gm.from_id <> ? AND gm.id > COALESCE(m.last_read_id, 0)
      GROUP BY gm.group_id`
  )
    .bind(me.id, me.id)
    .all()
    .catch(() => ({ results: [] }));
  const unreadBy = new Map((unreadRows || []).map((r) => [r.group_id, Number(r.n) || 0]));

  // 成员:一次查齐,再按群分组;头像只取前 4 个用来画叠头像
  const { results: memberRows } = await env.DB.prepare(
    `SELECT group_id, user_id FROM group_members WHERE group_id IN (${holes}) ORDER BY created_at ASC`
  )
    .bind(...ids)
    .all()
    .catch(() => ({ results: [] }));

  const authors = await loadAuthors(
    env.DB,
    (memberRows || []).map((r) => ({ user_id: r.user_id })),
    me
  );

  const membersBy = new Map();
  for (const r of memberRows || []) {
    if (!membersBy.has(r.group_id)) membersBy.set(r.group_id, []);
    const u = authors.get(r.user_id);
    if (u) membersBy.get(r.group_id).push(u);
  }

  return json({
    ok: true,
    groups: list.map((g) => {
      const members = membersBy.get(g.id) || [];
      const last = lastBy.get(g.id) || null;
      return {
        id: g.id,
        name: g.name,
        owner_id: g.owner_id,
        created_at: g.created_at,
        memberCount: members.length,
        members: members.slice(0, 4),
        last: last ? { body: last.body, created_at: last.created_at, mine: last.from_id === me.id ? 1 : 0 } : null,
        unread: unreadBy.get(g.id) || 0,
      };
    }),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能建群", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const name = String((payload && payload.name) || "").replace(/[\r\n\t]/g, " ").trim().slice(0, MAX_NAME);
  if (!name) return fail("给这个群起个名字吧");

  // 发起人一定在群里;拉的人去重、去掉自己、去掉封禁账号
  const wanted = Array.from(
    new Set((Array.isArray(payload.members) ? payload.members : []).map((x) => parseInt(x, 10)).filter((n) => n > 0 && n !== me.id))
  ).slice(0, MAX_MEMBERS - 1);

  let invited = [];
  if (wanted.length) {
    const holes = wanted.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${holes}) AND (banned IS NULL OR banned = 0)`
    )
      .bind(...wanted)
      .all()
      .catch(() => ({ results: [] }));
    invited = (results || []).map((r) => r.id);
  }

  const now = Date.now();
  const res = await env.DB.prepare("INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?)")
    .bind(name, me.id, now)
    .run();
  const gid = res.meta.last_row_id;

  const all = [me.id, ...invited];
  await env.DB.batch(
    all.map((uid) =>
      env.DB
        .prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, last_read_id, created_at) VALUES (?, ?, 0, ?)")
        .bind(gid, uid, now)
    )
  );

  return json({
    ok: true,
    group: { id: gid, name: name, owner_id: me.id, created_at: now, memberCount: all.length },
  });
}
