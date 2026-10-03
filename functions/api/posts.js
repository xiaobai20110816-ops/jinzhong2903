/* ============================================================
   103 纪事 · 帖子接口
   GET  /api/posts?page=1          读主留言板(倒序分页,服主置顶排最前)
   GET  /api/posts?author=<id>     读某个人发过的主帖
   GET  /api/posts?wall=<id>       读某个人的「个人主页留言墙」(扁平一层)
   POST /api/posts                 发一条(登录后才能发)

   回复结构参考 B 站:所有回复都拍平成一层挂在主帖下面,
   每条回复用 reply_to_name 说明「回复的是谁」,不再一层套一层。
   留言墙的留言挂在 posts 表里用 wall_id 区分,不进主留言板。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  toPost,
  loadThread,
  IMAGE_KEY_RE,
  regionOf,
  POST_COLS,
} from "./_utils.js";

const PAGE_SIZE = 20;
const MAX_BODY = 4000;
const MAX_IMAGES = 3;
const COOLDOWN_MS = 15000; // 同一个账号 15 秒内只能发一条新帖
const REPLY_COOLDOWN_MS = 3000; // 回复 / 留言墙放宽到 3 秒,不然聊不起来

/* 作者资料一次查齐,别逐条查库 */
async function loadAuthors(db, rows) {
  const uids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const authors = new Map();
  if (!uids.length) return authors;

  const holes = uids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT id, username, role, avatar_key FROM users WHERE id IN (${holes})`)
    .bind(...uids)
    .all();
  for (const u of results || []) {
    authors.set(u.id, {
      id: u.id,
      name: u.username,
      role: u.role || "member",
      avatar: u.avatar_key || "",
    });
  }
  return authors;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const authorId = parseInt(url.searchParams.get("author") || "0", 10) || 0;
  const wallId = parseInt(url.searchParams.get("wall") || "0", 10) || 0;

  // ---- 个人主页留言墙:扁平一层,不挂回复树 ----
  if (wallId) {
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE wall_id = ? AND parent_id IS NULL"
    )
      .bind(wallId)
      .first();

    const { results: roots } = await env.DB.prepare(
      `SELECT ${POST_COLS}
         FROM posts
        WHERE wall_id = ? AND parent_id IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
      .bind(wallId, PAGE_SIZE, offset)
      .all();

    const list = roots || [];
    const authors = await loadAuthors(env.DB, list);
    return json({
      ok: true,
      total: totalRow ? totalRow.n : 0,
      page,
      size: PAGE_SIZE,
      posts: list.map((r) => ({
        ...toPost(r),
        author: authors.get(r.user_id) || null,
        replies: [],
      })),
    });
  }

  // ---- 主留言板 / 某个人的主帖 ----
  // 分页分的是「主帖」,回复跟着主帖一起出来,不会被翻页截断
  const where = authorId
    ? "parent_id IS NULL AND wall_id IS NULL AND user_id = ?"
    : "parent_id IS NULL AND wall_id IS NULL";
  const bindWhere = authorId ? [authorId] : [];

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`)
    .bind(...bindWhere)
    .first();

  const { results: roots } = await env.DB.prepare(
    `SELECT ${POST_COLS}
       FROM posts
      WHERE ${where}
      ORDER BY pinned DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...bindWhere, PAGE_SIZE, offset)
    .all();

  const list = roots || [];
  const rows = [...list, ...(await loadThread(env.DB, list.map((r) => r.id)))];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const authors = await loadAuthors(env.DB, rows);

  const out = list.map((r) => ({
    ...toPost(r),
    author: authors.get(r.user_id) || null,
    replies: [],
  }));
  const rootById = new Map(out.map((r) => [r.id, r]));

  // 顺着 parent 往上找到主帖(老数据可能更深,这里一律归到根)
  function rootIdOf(row) {
    let cur = row;
    let guard = 0;
    while (cur && cur.parent_id && guard++ < 50) {
      const up = rowById.get(cur.parent_id);
      if (!up) break; // 父帖被删了,就把它自己当根
      cur = up;
    }
    return cur ? cur.id : 0;
  }

  for (const row of rows) {
    if (!row.parent_id) continue;
    const root = rootById.get(rootIdOf(row));
    if (!root) continue;

    // reply_to_id 是新字段;老回复没有它,那就用真正的父帖当「回复对象」
    const targetId = row.reply_to_id || row.parent_id;
    const target = rowById.get(targetId);
    root.replies.push({
      ...toPost(row),
      author: authors.get(row.user_id) || null,
      reply_to_name: target ? target.name : "",
    });
  }

  // 回复按时间从早到晚排,和聊天记录一个方向
  for (const r of out) r.replies.sort((a, b) => a.created_at - b.created_at || a.id - b.id);

  return json({ ok: true, total: totalRow ? totalRow.n : 0, page, size: PAGE_SIZE, posts: out });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能发言", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const body = String(payload.body || "").trim().slice(0, MAX_BODY);
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .map(String)
    .filter((k) => IMAGE_KEY_RE.test(k))
    .slice(0, MAX_IMAGES);
  const replyTo = parseInt(payload.reply_to_id, 10) || 0;
  const wallId = parseInt(payload.wall, 10) || 0;

  if (!body && images.length === 0) return fail("写点什么，或者放张图吧");

  // 留言墙:挂在别人(或自己)的个人主页上,不进主留言板
  if (wallId) {
    const target = await env.DB.prepare("SELECT id, banned FROM users WHERE id = ?")
      .bind(wallId)
      .first();
    if (!target || target.banned) return fail("找不到这个人", 404);

    const nowWall = Date.now();
    const lastWall = await env.DB.prepare(
      "SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(me.id)
      .first();
    if (lastWall && nowWall - lastWall.created_at < REPLY_COOLDOWN_MS) {
      const wait = Math.ceil((REPLY_COOLDOWN_MS - (nowWall - lastWall.created_at)) / 1000);
      return fail(`发得有点快啦，${wait} 秒后再来`, 429);
    }

    const regionWall = regionOf(request);
    const resWall = await env.DB.prepare(
      `INSERT INTO posts (name, body, images, salt, pass_hash, cid, parent_id, user_id, region, reply_to_id, pinned, wall_id, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, 0, ?, ?)`
    )
      .bind(me.name, body, JSON.stringify(images), me.id, regionWall, wallId, nowWall)
      .run();

    return json({
      ok: true,
      post: {
        id: resWall.meta.last_row_id,
        name: me.name,
        body,
        images,
        region: regionWall,
        parent_id: null,
        reply_to_id: 0,
        pinned: 0,
        wall_id: wallId,
        author: me,
        reply_to_name: "",
        replies: [],
        created_at: nowWall,
      },
    });
  }

  // 回复:不管回复的是主帖还是别人,一律挂到主帖下面,回复关系记在 reply_to_id
  let parentId = null;
  if (replyTo) {
    const target = await env.DB.prepare("SELECT id, parent_id FROM posts WHERE id = ?")
      .bind(replyTo)
      .first();
    if (!target) return fail("要回复的那条已经不在了，刷新一下再看看");
    parentId = target.parent_id || target.id;
  }

  const now = Date.now();
  const last = await env.DB.prepare(
    "SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(me.id)
    .first();
  const waitMs = parentId ? REPLY_COOLDOWN_MS : COOLDOWN_MS;
  if (last && now - last.created_at < waitMs) {
    const wait = Math.ceil((waitMs - (now - last.created_at)) / 1000);
    return fail(`发得有点快啦，${wait} 秒后再来`, 429);
  }

  // IP 属地:只算到省份;服主发的主帖自动置顶
  const region = regionOf(request);
  const pinned = me.role === "owner" && !parentId ? 1 : 0;

  const res = await env.DB.prepare(
    `INSERT INTO posts (name, body, images, salt, pass_hash, cid, parent_id, user_id, region, reply_to_id, pinned, wall_id, created_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      me.name,
      body,
      JSON.stringify(images),
      parentId,
      me.id,
      region,
      replyTo || null,
      pinned,
      now
    )
    .run();

  return json({
    ok: true,
    post: {
      id: res.meta.last_row_id,
      name: me.name,
      body,
      images,
      region,
      parent_id: parentId,
      reply_to_id: replyTo,
      pinned,
      wall_id: 0,
      author: me,
      reply_to_name: "",
      replies: [],
      created_at: now,
    },
  });
}
