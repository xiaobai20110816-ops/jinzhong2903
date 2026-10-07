/* ============================================================
   103 · 一对一会话
   GET  /api/messages/with/:uid   读我和 TA 的对话(GET 顺带把 TA 发来的标为已读)
   POST /api/messages/with/:uid   发一条私信

   分页 ?before=<消息id>:一次 50 条,先按 id 倒序取,再翻成正序返回。
   私聊允许多行,所以清洗正文时只剔除控制字符、保留换行。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, classGate, namedUser } from "../../_utils.js";

const PAGE = 50;
const MAX_BODY = 500;
const SEND_GAP_MS = 1000; // 同一个发送者 1 秒内只能发一条

/* 统一换行、去掉除换行外的控制字符,再去掉首尾空白 */
function cleanBody(raw) {
  return String(raw == null ? "" : raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

const PEER_COLS =
  "id, username, avatar_key, role, real_name, verified, display_name, cert_title, cert_level, banned";

async function loadPeer(db, id) {
  return db.prepare(`SELECT ${PEER_COLS} FROM users WHERE id = ?`).bind(id).first();
}

/* 双方消息的 where 片段;before 有值就只取比它更早的 */
function pairWhere(before) {
  return before
    ? "((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id < ?"
    : "(from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)";
}

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const uid = parseInt(params.uid, 10);
  if (!uid || uid === me.id) return fail("不能和自己私聊");

  const peer = await loadPeer(env.DB, uid);
  if (!peer) return fail("找不到这个人", 404);

  const before = parseInt(new URL(request.url).searchParams.get("before") || "0", 10) || 0;

  // 多取一条:有第 51 条就说明上面还有更早的,hasMore 用它判断
  const binds = before
    ? [me.id, uid, uid, me.id, before, PAGE + 1]
    : [me.id, uid, uid, me.id, PAGE + 1];
  const { results } = await env.DB.prepare(
    `SELECT id, from_id, body, created_at FROM messages WHERE ${pairWhere(before)} ORDER BY id DESC LIMIT ?`
  )
    .bind(...binds)
    .all();

  const rows = results || [];
  const hasMore = rows.length > PAGE;
  const slice = hasMore ? rows.slice(0, PAGE) : rows;
  slice.reverse(); // 倒序查完翻回正序,前端直接从头往下画

  const items = slice.map((r) => ({
    id: r.id,
    body: r.body,
    created_at: r.created_at,
    mine: r.from_id === me.id ? 1 : 0,
  }));

  // 打开了对话 = 看过了:把对方发给我的一次性标已读
  await env.DB.prepare("UPDATE messages SET read = 1 WHERE from_id = ? AND to_id = ? AND read = 0")
    .bind(uid, me.id)
    .run();

  return json({ ok: true, peer: namedUser(peer, me), items, hasMore });
}

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const uid = parseInt(params.uid, 10);
  if (!uid || uid === me.id) return fail("不能和自己私聊");

  const peer = await loadPeer(env.DB, uid);
  if (!peer) return fail("找不到这个人", 404);
  if (peer.banned) return fail("对方账号已被封禁");

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const body = cleanBody(payload && payload.body);
  if (!body) return fail("写点什么再发吧");
  if (body.length > MAX_BODY) return fail(`一条私信最多 ${MAX_BODY} 个字，精简一下吧`);

  // 最简限流:看这个发送者最近一条的时间,1 秒内连发就拦住
  const now = Date.now();
  const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM messages WHERE from_id = ?")
    .bind(me.id)
    .first();
  if (last && last.t && now - last.t < SEND_GAP_MS) return fail("说太快啦，歇一秒再发", 429);

  const res = await env.DB.prepare(
    "INSERT INTO messages (from_id, to_id, body, read, created_at) VALUES (?, ?, ?, 0, ?)"
  )
    .bind(me.id, uid, body, now)
    .run();

  return json({
    ok: true,
    message: { id: res.meta.last_row_id, body: body, created_at: now, mine: 1 },
  });
}
