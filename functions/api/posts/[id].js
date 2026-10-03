/* ============================================================
   103 纪事 · 单条帖子
   PUT    /api/posts/:id   { pinned }  服主/管理员置顶或取消置顶(只对主帖有效)
   DELETE /api/posts/:id               本人可删自己的;服主/管理员可删任意一条
                                       删主帖会连带删掉它下面所有回复及图片
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  ensureOwner,
  currentUser,
  isStaff,
  safeParse,
  IMAGE_KEY_RE,
} from "../_utils.js";

/* 广度优先把这条帖子下面所有回复的 id 收齐(含自己) */
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

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureOwner(env.DB, env);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主和管理员能置顶", 403);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  let payload = {};
  try {
    payload = await request.json();
  } catch (e) {
    /* 没有 body 就当取消置顶 */
  }

  const row = await env.DB.prepare("SELECT id, parent_id FROM posts WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这条已经不在了", 404);
  if (row.parent_id) return fail("只能置顶主帖");

  const pinned = payload.pinned ? 1 : 0;
  await env.DB.prepare("UPDATE posts SET pinned = ? WHERE id = ?").bind(pinned, id).run();

  return json({ ok: true, id, pinned });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureOwner(env.DB, env);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  const row = await env.DB.prepare("SELECT id, user_id FROM posts WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这条已经不在了", 404);

  const mine = !!row.user_id && row.user_id === me.id;
  if (!mine && !isStaff(me)) return fail("只能删自己发的，管理身份可以删任意一条", 403);

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
