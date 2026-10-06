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
import { b2Config, s3Delete, isB2Key, b2ObjectName } from "../_b2.js";

export async function onRequestDelete({ request, env, params }) {
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

  // 原图可能在 B2,也可能在 KV(老数据 / 没配 B2 时),按前缀分流。
  // 删不掉也不致命:元数据没了,残留的孤儿对象不影响列表
  if (isB2Key(row.full_key)) {
    const b2 = await b2Config(env, env.DB);
    if (b2.ready) await s3Delete(b2, b2ObjectName(row.full_key)).catch(() => {});
  } else if (env.STORY_KV) {
    await env.STORY_KV.delete("gal:" + row.full_key).catch(() => {});
  }
  // 缩略图一直在 KV
  await env.STORY_KV.delete("gal:" + row.thumb_key).catch(() => {});

  return json({ ok: true });
}
