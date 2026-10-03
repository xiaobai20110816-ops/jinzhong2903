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
  IMAGE_KEY_RE,
} from "./_utils.js";

const PAGE_SIZE = 20;
const MAX_NAME = 24;
const MAX_BODY = 4000;
const MAX_IMAGES = 3;
const COOLDOWN_MS = 15000; // 同一个浏览器 15 秒内只能发一条

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first();
  const { results } = await env.DB.prepare(
    `SELECT id, name, body, images, created_at
       FROM posts
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(PAGE_SIZE, offset)
    .all();

  return json({
    ok: true,
    total: totalRow ? totalRow.n : 0,
    page,
    size: PAGE_SIZE,
    posts: (results || []).map((row) => ({
      id: row.id,
      name: row.name,
      body: row.body,
      images: safeParse(row.images).filter((k) => IMAGE_KEY_RE.test(k)),
      created_at: row.created_at,
    })),
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

  if (!body && images.length === 0) return fail("写点什么，或者放张图吧");
  if (password.length < 4 || password.length > 32) return fail("删帖口令请设 4~32 位");

  const now = Date.now();

  if (cid) {
    const last = await env.DB.prepare(
      "SELECT created_at FROM posts WHERE cid = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(cid)
      .first();
    if (last && now - last.created_at < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (now - last.created_at)) / 1000);
      return fail(`发得有点快啦，${wait} 秒后再来`, 429);
    }
  }

  const salt = randomHex(8);
  const passHash = await hashPassword(password, salt);

  const res = await env.DB.prepare(
    `INSERT INTO posts (name, body, images, salt, pass_hash, cid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(name, body, JSON.stringify(images), salt, passHash, cid, now)
    .run();

  return json({
    ok: true,
    post: { id: res.meta.last_row_id, name, body, images, created_at: now },
  });
}
