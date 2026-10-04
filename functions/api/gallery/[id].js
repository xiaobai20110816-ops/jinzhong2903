/* ============================================================
   103 纪事 · 图库删除
   DELETE /api/gallery/:id   删掉一张图(原图 + 缩略图 + 元数据)
   上传者本人能删自己的;服主 / 管理员能删所有人的
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
} from "../_utils.js";

export async function onRequestDelete({ request, env, params }) {
  if (!env.STORY_KV) return notReady("图片存储");
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能操作", 401);

  const id = parseInt(params.id, 10) || 0;
  if (!id) return fail("没说删哪张");

  const row = await env.DB.prepare(
    "SELECT full_key, thumb_key, uploaded_by FROM gallery WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!row) return fail("这张图不存在", 404);

  // 自己的图能删;管理员 / 服主能删任何人的
  const isMine = row.uploaded_by === me.id;
  if (!isMine && !isStaff(me)) return fail("只能删自己上传的照片", 403);

  await env.DB.prepare("DELETE FROM gallery WHERE id = ?").bind(id).run();
  // KV 删不掉也不致命,元数据没了,残留的孤儿 key 不影响列表
  await env.STORY_KV.delete("gal:" + row.full_key).catch(() => {});
  await env.STORY_KV.delete("gal:" + row.thumb_key).catch(() => {});

  return json({ ok: true });
}
