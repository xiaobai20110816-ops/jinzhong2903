/* ============================================================
   103 纪事 · 删帖
   DELETE /api/posts/:id   带上发帖时设的口令;
                           口令等于 ADMIN_PASSWORD 时,可删任意一条(班委/老师清理用)
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

  const row = await env.DB.prepare("SELECT id, salt, pass_hash, images FROM posts WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这条已经不在了", 404);

  const admin = String(env.ADMIN_PASSWORD || "");
  const isAdmin = admin.length > 0 && password === admin;
  const isOwner = !!row.pass_hash && (await hashPassword(password, row.salt)) === row.pass_hash;

  if (!isAdmin && !isOwner) return fail("口令不对", 403);

  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

  // 顺手把这条帖子带的图片从 KV 里清掉,别白占免费额度
  if (env.STORY_KV) {
    for (const key of safeParse(row.images)) {
      if (!IMAGE_KEY_RE.test(key)) continue;
      try {
        await env.STORY_KV.delete("img:" + key);
      } catch (e) {
        /* 删不掉就算了,不阻塞删帖 */
      }
    }
  }

  return json({ ok: true });
}
