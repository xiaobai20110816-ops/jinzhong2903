/* ============================================================
   103 · 一个群的对话
   GET  /api/groups/:id   读群消息(GET 顺带把「我读到哪了」推进到最新)
   POST /api/groups/:id   往群里发一条

   只有群成员能读能发。分页 ?before=<消息id>,一次 50 条,
   先按 id 倒序取再翻成正序,和一对一私信一个套路。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, classGate, namedUser } from "../_utils.js";

const PAGE = 50;
const MAX_BODY = 500;
const SEND_GAP_MS = 1000;

function cleanBody(raw) {
  return String(raw == null ? "" : raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

/* 认出这个群,并确认「我」在里面 */
async function loadGroup(db, gid, meId) {
  const g = await db
    .prepare(
      `SELECT g.id, g.name, g.owner_id, g.created_at
         FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
        WHERE g.id = ?`
    )
    .bind(meId, gid)
    .first();
  return g || null;
}

async function loadMembers(db, gid, me) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.username, u.avatar_key, u.role, u.real_name, u.verified,
              u.display_name, u.cert_title, u.cert_level
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ?
        ORDER BY m.created_at ASC`
    )
    .bind(gid)
    .all()
    .catch(() => ({ results: [] }));
  return (results || []).map((u) => namedUser(u, me));
}

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const gid = parseInt(params.id, 10);
  if (!gid) return fail("找不到这个群", 404);

  const g = await loadGroup(env.DB, gid, me.id);
  if (!g) return fail("你不在这个群里", 403);

  const before = parseInt(new URL(request.url).searchParams.get("before") || "0", 10) || 0;
  const rows = await env.DB.prepare(
    `SELECT id, from_id, body, created_at FROM group_messages
      WHERE group_id = ?${before ? " AND id < ?" : ""}
      ORDER BY id DESC LIMIT ?`
  )
    .bind(...(before ? [gid, before, PAGE + 1] : [gid, PAGE + 1]))
    .all()
    .catch(() => ({ results: [] }));

  const list = rows.results || [];
  const hasMore = list.length > PAGE;
  const slice = hasMore ? list.slice(0, PAGE) : list;
  slice.reverse();

  // 打开这个群 = 读到最新:把游标推到当前最大 id(取过更早的就别乱动)
  if (!before && slice.length) {
    await env.DB.prepare("UPDATE group_members SET last_read_id = ? WHERE group_id = ? AND user_id = ?")
      .bind(slice[slice.length - 1].id, gid, me.id)
      .run()
      .catch(() => {});
  }

  const items = slice.map((r) => ({
    id: r.id,
    body: r.body,
    created_at: r.created_at,
    mine: r.from_id === me.id ? 1 : 0,
    from_id: r.from_id,
  }));

  return json({
    ok: true,
    group: { id: g.id, name: g.name, owner_id: g.owner_id, created_at: g.created_at },
    members: await loadMembers(env.DB, gid, me),
    items,
    hasMore,
  });
}

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const gid = parseInt(params.id, 10);
  if (!gid) return fail("找不到这个群", 404);

  const g = await loadGroup(env.DB, gid, me.id);
  if (!g) return fail("你不在这个群里", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const body = cleanBody(payload && payload.body);
  if (!body) return fail("写点什么再发吧");
  if (body.length > MAX_BODY) return fail(`一条消息最多 ${MAX_BODY} 个字，精简一下吧`);

  const now = Date.now();
  const last = await env.DB.prepare(
    "SELECT MAX(created_at) AS t FROM group_messages WHERE from_id = ?"
  )
    .bind(me.id)
    .first()
    .catch(() => null);
  if (last && last.t && now - last.t < SEND_GAP_MS) return fail("说太快啦，歇一秒再发", 429);

  const res = await env.DB.prepare(
    "INSERT INTO group_messages (group_id, from_id, body, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(gid, me.id, body, now)
    .run();

  // 自己发的不算未读:顺手把自己的游标推过去
  await env.DB.prepare("UPDATE group_members SET last_read_id = ? WHERE group_id = ? AND user_id = ?")
    .bind(res.meta.last_row_id, gid, me.id)
    .run()
    .catch(() => {});

  return json({
    ok: true,
    message: { id: res.meta.last_row_id, body: body, created_at: now, mine: 1, from_id: me.id },
  });
}
