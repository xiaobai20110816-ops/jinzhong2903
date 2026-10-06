/* ============================================================
   103 · 视频列表的公共装配
   列表页 / 首页合并流 / 详情页都要「作者 + 点赞 + 收藏 + 评论数 + 在线」,
   逐条查会打爆数据库,这里统一用批量 SQL 一次补齐。
   文件名以下划线开头,不会被当成路由。
   ============================================================ */

import {
  toPost,
  toVideo,
  loadAuthors,
  onlineUserIds,
  videoLikeCounts,
  videoLikedBy,
  videoFavCounts,
  videoFavedBy,
} from "./_utils.js";

/* 一批视频各有多少条评论(评论挂在 posts 表的 video_id 上) */
async function commentCounts(db, ids) {
  const uniq = Array.from(new Set((ids || []).map((n) => parseInt(n, 10)).filter((n) => n > 0)));
  const out = new Map();
  if (!uniq.length) return out;
  const holes = uniq.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT video_id AS id, COUNT(*) AS n FROM posts WHERE video_id IN (${holes}) GROUP BY video_id`
    )
    .bind(...uniq)
    .all()
    .catch(() => ({ results: [] }));
  for (const r of results || []) out.set(r.id, Number(r.n) || 0);
  return out;
}

/* rows → 前端要的完整视频对象数组(顺序不变) */
export async function decorateVideos(db, rows, me) {
  const list = rows || [];
  if (!list.length) return [];

  const ids = list.map((r) => r.id);
  const [likes, liked, favs, faved, online, authors, comments] = await Promise.all([
    videoLikeCounts(db, ids),
    videoLikedBy(db, me && me.id, ids),
    videoFavCounts(db, ids),
    videoFavedBy(db, me && me.id, ids),
    onlineUserIds(db, list.map((r) => r.user_id)),
    loadAuthors(db, list, me),
    commentCounts(db, ids),
  ]);

  return list.map((r) => {
    const a = authors.get(r.user_id) || null;
    return {
      ...toVideo(r),
      author: a ? { ...a, online: online.has(r.user_id) ? 1 : 0 } : null,
      likes: likes.get(r.id) || 0,
      liked: liked.has(r.id) ? 1 : 0,
      favs: favs.get(r.id) || 0,
      faved: faved.has(r.id) ? 1 : 0,
      comments: comments.get(r.id) || 0,
    };
  });
}

/* 视频下面的一批评论(挂在 posts 表上)→ 带作者、带「回复 @某某」,
   和留言板的回复是同一套字段,前端可以复用同一套渲染 */
export async function decorateComments(db, rows, me) {
  const list = rows || [];
  if (!list.length) return [];

  const authors = await loadAuthors(db, list, me);
  const byId = new Map(list.map((r) => [r.id, r]));

  return list.map((row) => {
    const targetId = row.reply_to_id || row.parent_id;
    const target = byId.get(targetId);
    const targetAuthor = target ? authors.get(target.user_id) : null;
    return {
      ...toPost(row),
      author: authors.get(row.user_id) || null,
      reply_to_name: targetAuthor
        ? targetAuthor.display_name || targetAuthor.real_name || targetAuthor.name
        : target
        ? target.name
        : "",
      reply_to_verified: targetAuthor && targetAuthor.verified && targetAuthor.real_name ? 1 : 0,
    };
  });
}
