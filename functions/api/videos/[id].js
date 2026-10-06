/* ============================================================
   103 · 单个视频
   GET    /api/videos/:id   视频本身 + 全部评论(评论挂在 posts 表的 video_id 上)
   DELETE /api/videos/:id   本人或服主 / 管理员:删视频 + 评论 + 点赞收藏 + B2 上的文件
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  safeParse,
  IMAGE_KEY_RE,
  POST_COLS,
} from "../_utils.js";
import { decorateVideos, decorateComments } from "../_videos.js";
import { b2Config, s3Delete, videoObjectName } from "../_b2.js";

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const id = parseInt(params.id, 10);
  if (!id) return fail("视频编号不对");

  const me = await currentUser(request, env);

  const row = await env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first();
  if (!row) return fail("这个视频已经不在了", 404);
  if (row.visibility === "class" && !me) return fail("这条内容仅本班同学可见", 403);

  const [video] = await decorateVideos(env.DB, [row], me);

  const { results } = await env.DB.prepare(
    `SELECT ${POST_COLS} FROM posts WHERE video_id = ? ORDER BY created_at ASC, id ASC`
  )
    .bind(id)
    .all();

  const comments = await decorateComments(env.DB, results || [], me);

  return json({ ok: true, video, comments });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("视频编号不对");

  const row = await env.DB.prepare("SELECT id, user_id, b2_key, cover_key FROM videos WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这个视频已经不在了", 404);

  const mine = !!row.user_id && row.user_id === me.id;
  if (!mine && !isStaff(me)) return fail("只能删自己发的，管理身份可以删任意一条", 403);

  // 评论的配图先捞出来,删完记录就查不到了
  const { results: crows } = await env.DB.prepare(
    "SELECT images FROM posts WHERE video_id = ?"
  )
    .bind(id)
    .all();

  await env.DB.prepare("DELETE FROM posts WHERE video_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM video_likes WHERE video_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM video_favs WHERE video_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(id).run();

  // B2 上的原片顺手删掉,别白占那 10GB 免费额度
  try {
    const b2 = await b2Config(env, env.DB);
    if (b2.ready && row.b2_key) await s3Delete(b2, videoObjectName(row.b2_key));
  } catch (e) {
    /* 删不掉就算了,不阻塞删视频 */
  }

  // 封面和评论配图都在 KV
  if (env.STORY_KV) {
    if (row.cover_key && IMAGE_KEY_RE.test(row.cover_key)) {
      await env.STORY_KV.delete("img:" + row.cover_key).catch(() => {});
    }
    for (const r of crows || []) {
      for (const key of safeParse(r.images)) {
        if (!IMAGE_KEY_RE.test(key)) continue;
        await env.STORY_KV.delete("img:" + key).catch(() => {});
      }
    }
  }

  return json({ ok: true, id });
}
