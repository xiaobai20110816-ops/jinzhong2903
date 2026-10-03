/* ============================================================
   103 纪事 · 帖子接口
   GET  /api/posts?page=1   读列表(倒序分页)
   POST /api/posts          发一条
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  hashPassword,
  randomHex,
  safeParse,
  toPost,
  loadThread,
  IMAGE_KEY_RE,
} from "./_utils.js";

const PAGE_SIZE = 20;
const MAX_NAME = 24;
const MAX_BODY = 4000;
const MAX_IMAGES = 3;
const COOLDOWN_MS = 15000; // 同一个浏览器 15 秒内只能发一条新帖
const REPLY_COOLDOWN_MS = 3000; // 回复放宽到 3 秒,不然聊不起来

/* 把扁平的一页记录拼成「根帖 → replies」的树。
   深度不限:回复的回复会一直挂在 replies 里,由前端决定怎么缩进。 */
function buildTree(rows) {
  const nodes = new Map();
  for (const row of rows) {
    nodes.set(row.id, { ...toPost(row), parent_id: row.parent_id || 0, replies: [] });
  }
  const tree = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : null;
    if (parent) parent.replies.push(node);
    else if (!node.parent_id) tree.push(node);
  }
  tree.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  return tree;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // 分页分的是「根帖」,整棵回复树跟着根帖一起出来,不会被翻页截断
  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE parent_id IS NULL"
  ).first();

  const { results: roots } = await env.DB.prepare(
    `SELECT id, name, body, images, parent_id, created_at
       FROM posts
      WHERE parent_id IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(PAGE_SIZE, offset)
    .all();

  const list = roots || [];
  const rows = [...list, ...(await loadThread(env.DB, list.map((r) => r.id)))];

  return json({
    ok: true,
    total: totalRow ? totalRow.n : 0,
    page,
    size: PAGE_SIZE,
    posts: buildTree(rows),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const name = (String(payload.name || "").trim() || "匿名同学").slice(0, MAX_NAME);
  const body = String(payload.body || "").trim().slice(0, MAX_BODY);
  const password = String(payload.password || "").trim();
  const cid = String(payload.cid || "").slice(0, 64);
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .map(String)
    .filter((k) => IMAGE_KEY_RE.test(k))
    .slice(0, MAX_IMAGES);

  // 回复:带上 parent_id 就挂到那条下面,不带就是新帖
  const parentId = parseInt(payload.parent_id, 10) || 0;
  if (parentId) {
    const parent = await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(parentId).first();
    if (!parent) return fail("要回复的那条已经不在了，刷新一下再看看");
  }

  if (!body && images.length === 0) return fail("写点什么，或者放张图吧");
  if (password.length < 4 || password.length > 32) return fail("删帖口令请设 4~32 位");

  const now = Date.now();

  if (cid) {
    const last = await env.DB.prepare(
      "SELECT created_at FROM posts WHERE cid = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(cid)
      .first();
    const wait_ms = parentId ? REPLY_COOLDOWN_MS : COOLDOWN_MS;
    if (last && now - last.created_at < wait_ms) {
      const wait = Math.ceil((wait_ms - (now - last.created_at)) / 1000);
      return fail(`发得有点快啦，${wait} 秒后再来`, 429);
    }
  }

  const salt = randomHex(8);
  const passHash = await hashPassword(password, salt);

  const res = await env.DB.prepare(
    `INSERT INTO posts (name, body, images, salt, pass_hash, cid, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(name, body, JSON.stringify(images), salt, passHash, cid, parentId || null, now)
    .run();

  return json({
    ok: true,
    post: {
      id: res.meta.last_row_id,
      name,
      body,
      images,
      parent_id: parentId,
      replies: [],
      created_at: now,
    },
  });
}
