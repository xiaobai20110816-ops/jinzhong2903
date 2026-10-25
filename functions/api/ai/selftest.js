/* 临时自检接口:跑一遍完整的「@AI 助手 → 生成 → 落库 → 读回 → 删除」流程。
   只给服主排查用,填好 key 后访问:
   /api/ai/selftest?k=st-7f3a91c4e2&kind=text|photo|video
   排查完立刻删除本文件。 */

import { json, ensureSchema } from "../_utils.js";
import { replyAsAi } from "../_ai_comment.js";

const KEY = "st-7f3a91c4e2";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return json({ ok: false, error: "no" }, 404);
  if (!env || !env.DB) return json({ ok: false, error: "no-db" }, 500);

  await ensureSchema(env.DB);

  const kind = url.searchParams.get("kind") || "text";
  const out = { ok: true, kind, aiReady: !!(env.AI && env.AI.run) };

  let rootId = 0;
  let galleryId = 0;
  let videoId = 0;

  if (kind === "photo") {
    const row = await env.DB.prepare("SELECT id FROM gallery ORDER BY id DESC LIMIT 1").first();
    if (!row) {
      out.reply = { ok: false, stage: "no-gallery-row" };
      return json(out);
    }
    galleryId = row.id;
  } else if (kind === "video") {
    const row = await env.DB.prepare("SELECT id FROM videos ORDER BY id DESC LIMIT 1").first();
    if (!row) {
      out.reply = { ok: false, stage: "no-video-row" };
      return json(out);
    }
    videoId = row.id;
  } else {
    const row = await env.DB.prepare(
      "SELECT id FROM posts WHERE parent_id IS NULL ORDER BY id DESC LIMIT 1"
    ).first();
    rootId = (row && row.id) || 0;
  }

  // 让 AI 真去看图 / 看视频:用最新一条素材,内容真实
  const body = kind === "photo" ? "@AI助手 这张照片拍得怎么样？" : kind === "video" ? "@AI助手 这个视频怎么样？" : "@AI助手 你觉得呢？";

  const t0 = Date.now();
  out.reply = await replyAsAi(env, {
    postId: rootId,
    rootId: rootId,
    body,
    authorId: 0,
    galleryId,
    videoId,
    debug: true,
  });
  out.totalMs = Date.now() - t0;

  // 读回来看看关键字段写对没有
  if (out.reply && out.reply.ok && out.reply.id) {
    const row = await env.DB.prepare(
      "SELECT id, name, user_id, parent_id, wall_id, video_id, gallery_id, reply_to_id, visibility FROM posts WHERE id = ?"
    )
      .bind(out.reply.id)
      .first()
      .catch(() => null);
    out.row = row;
    // 按各页面真实的查询口径数一遍,验证「写进去了但页面看不到」这种情况
    if (videoId) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE video_id = ?").bind(videoId).first();
      out.visibleInVideoComments = (c && c.n) || 0;
    }
    if (galleryId) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE gallery_id = ?").bind(galleryId).first();
      out.visibleInGalleryComments = (c && c.n) || 0;
    }
    // 测试数据不留在线上
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(out.reply.id).run().catch(() => {});
    out.cleaned = true;
  }

  return json(out);
}
