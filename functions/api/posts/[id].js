/* ============================================================
   103 纪事 · 删帖
   DELETE /api/posts/:id   带上发帖时设的口令;
                           口令等于 ADMIN_PASSWORD 时,可删任意一条(班委/老师清理用)
                           删主帖会连带删掉它下面整棵回复子树
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  hashPassword,
  safeParse,
  IMAGE_KEY_RE,
} from "../_utils.js";

/* 广度优先把这条帖子下面所有回复的 id 收齐(含自己),
   顺便把每条带的图片 key 也收集起来 */
async function collectSubtree(db, rootId) {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const holes = frontier.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT id FROM posts WHERE parent_id IN (${holes})`)
      .bind(...frontier)
      .all();
    if (!results || !results.length) break;
    const next = results.map((r) => r.id);
    ids.push(...next);
    frontier = next;
  }
  return ids;
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  let payload = {};
  try {
    payload = await request.json();
  } catch (e) {
    /* 没带 body 也让它往下走,下面会提示补口令 */
  }
  const password = String(payload.password || "").trim();
  if (!password) return fail("请输入删帖口令");

  const row = await env.DB.prepare("SELECT id, salt, pass_hash FROM posts WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这条已经不在了", 404);

  const admin = String(env.ADMIN_PASSWORD || "");
  const isAdmin = admin.length > 0 && password === admin;
  const isOwner = !!row.pass_hash && (await hashPassword(password, row.salt)) === row.pass_hash;

  if (!isAdmin && !isOwner) return fail("口令不对", 403);

  // 整棵子树一起删:回复挂在不存在的父帖下面会变成孤儿,前端读不到也删不掉
  const ids = await collectSubtree(env.DB, id);

  // 先把这批帖子的图片 key 捞出来,删完记录就查不到了
  const holes = ids.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT images FROM posts WHERE id IN (${holes})`
  )
    .bind(...ids)
    .all();

  await env.DB.prepare(`DELETE FROM posts WHERE id IN (${holes})`)
    .bind(...ids)
    .run();

  // 顺手把这批帖子带的图片从 KV 里清掉,别白占免费额度
  if (env.STORY_KV) {
    for (const r of rows || []) {
      for (const key of safeParse(r.images)) {
        if (!IMAGE_KEY_RE.test(key)) continue;
        try {
          await env.STORY_KV.delete("img:" + key);
        } catch (e) {
          /* 删不掉就算了,不阻塞删帖 */
        }
      }
    }
  }

  return json({ ok: true, deleted: ids.length });
}
