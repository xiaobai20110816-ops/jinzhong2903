/* 临时自检:验证「主留言板 @AI 有没有拿到上下文」。
   /api/aicheck?k=ac-9b2f5d13
   取最近一条主留言板根帖 + 它下面最新的一条回复,走完整的 replyAsAi,
   拿到答案后立刻把写入的 AI 回复和通知删掉 —— 不留痕迹。测完删除本文件。 */

import { json } from "./_utils.js";
import { replyAsAi } from "./_ai_comment.js";

const KEY = "ac-9b2f5d13";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return json({ ok: false, error: "no" }, 404);
  if (!env || !env.DB) return json({ ok: false, error: "no-db" }, 500);

  const { results: roots } = await env.DB.prepare(
    `SELECT id, name, body FROM posts
      WHERE parent_id IS NULL AND wall_id IS NULL AND video_id IS NULL AND gallery_id IS NULL
      ORDER BY created_at DESC LIMIT 5`
  ).all();

  for (const root of roots || []) {
    const rep = await env.DB.prepare(
      "SELECT id, name, user_id, body FROM posts WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(root.id)
      .first()
      .catch(() => null);
    if (!rep || !rep.body) continue;

    const r = await replyAsAi(env, {
      postId: rep.id,
      rootId: root.id,
      body: rep.body,
      authorId: rep.user_id,
      galleryId: 0,
      videoId: 0,
      debug: true,
    });

    if (r && r.ok && r.id) {
      await env.DB.prepare("DELETE FROM notifications WHERE reply_id = ?").bind(r.id).run().catch(() => {});
      await env.DB.prepare("DELETE FROM posts WHERE id = ? AND name = 'AI 助手'").bind(r.id).run().catch(() => {});
    }

    return json({
      ok: true,
      root: { id: root.id, name: root.name, body: String(root.body || "").slice(0, 120) },
      rep: { id: rep.id, name: rep.name, body: String(rep.body || "").slice(0, 120) },
      result: r,
      cleaned: !!(r && r.ok && r.id),
    });
  }

  return json({ ok: false, error: "no-thread" });
}
