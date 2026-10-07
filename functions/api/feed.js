/* ============================================================
   103 · 首页合并流(小红书式)
   GET /api/feed?page=1&size=20

   首页那一屏不再是「帖子流」也不是「视频流」,而是两种卡片混在一起,
   按时间倒序往下铺 —— 和小红书一样。服主置顶的主帖照样浮在最前面。

   帖子和视频是两张表,没法用一条 SQL 分页,所以这里各取最近 400 条
   在内存里合并、排序、切片。一个班的量级完全够用(400+400 能翻 40 页),
   也不用为了「合并排序」把两张表硬塞进一张。
   ============================================================ */

import {
  notReady,
  ensureSchema,
  currentUser,
  toPost,
  POST_COLS,
  loadAuthors,
  likeCounts,
  likedBy,
  onlineUserIds,
} from "./_utils.js";
import { decorateVideos } from "./_videos.js";

const WINDOW = 400;

/* 游客那一份「合并流」在半小时内对谁都一样:不带个人点赞 / 收藏状态,
   可见性只出 public —— 所以可以整份丢进 KV 缓存 30 秒。
   首页是全班点得最多的一个接口,每次都要两条 LIMIT 400 的查询 + 一轮
   内存合并 + 一轮批量补资料;缓存住之后,并发进来的游客只读一次库。
   登录的人不看缓存(他们的点赞状态是个人的,不能串)。 */
const GUEST_TTL = 30;

function jsonNoStore(body, extra) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extra || {}),
    },
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const size = Math.min(
    40,
    Math.max(1, parseInt(url.searchParams.get("size") || "20", 10) || 20)
  );

  const me = await currentUser(request, env);

  // 游客:先看缓存里有没有现成的一份
  const guestKey = me ? "" : `feed:guest:${page}:${size}`;
  if (guestKey && env.STORY_KV) {
    const hit = await env.STORY_KV.get(guestKey, "text").catch(() => null);
    if (hit) return jsonNoStore(hit, { "x-feed-cache": "hit" });
  }
  // 「仅本班可见」的东西游客直接看不到,帖子和视频口径一致
  const postVis = me ? "" : " AND (visibility IS NULL OR visibility = 'public')";
  const videoVis = me ? "" : " AND (visibility IS NULL OR visibility = 'public')";

  const [postRes, videoRes] = await Promise.all([
    env.DB.prepare(
      `SELECT ${POST_COLS} FROM posts
        WHERE parent_id IS NULL AND wall_id IS NULL AND video_id IS NULL${postVis}
        ORDER BY pinned DESC, created_at DESC, id DESC
        LIMIT ?`
    )
      .bind(WINDOW)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT * FROM videos WHERE 1=1${videoVis}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
      .bind(WINDOW)
      .all()
      .catch(() => ({ results: [] })),
  ]);

  const posts = postRes.results || [];
  const videos = videoRes.results || [];

  // 置顶的主帖浮最前(视频没有置顶),其余一律按时间倒序
  const merged = [
    ...posts.map((r) => ({ type: "post", row: r, pin: r.pinned ? 1 : 0 })),
    ...videos.map((r) => ({ type: "video", row: r, pin: 0 })),
  ].sort((a, b) => {
    if (a.pin !== b.pin) return b.pin - a.pin;
    if (b.row.created_at !== a.row.created_at) return b.row.created_at - a.row.created_at;
    return b.row.id - a.row.id;
  });

  const slice = merged.slice((page - 1) * size, page * size);

  // ---- 批量补齐这一页要展示的东西 ----
  const postRows = slice.filter((x) => x.type === "post").map((x) => x.row);
  const videoRows = slice.filter((x) => x.type === "video").map((x) => x.row);
  const postIds = postRows.map((r) => r.id);

  const [counts, mine, online, authors, videoItems] = await Promise.all([
    likeCounts(env.DB, postIds),
    likedBy(env.DB, me && me.id, postIds),
    onlineUserIds(env.DB, postRows.map((r) => r.user_id)),
    loadAuthors(env.DB, postRows, me),
    decorateVideos(env.DB, videoRows, me),
  ]);

  const postItems = new Map(
    postRows.map((r) => {
      const a = authors.get(r.user_id) || null;
      return [
        r.id,
        {
          ...toPost(r),
          author: a ? { ...a, online: online.has(r.user_id) ? 1 : 0 } : null,
          likes: counts.get(r.id) || 0,
          liked: mine.has(r.id) ? 1 : 0,
        },
      ];
    })
  );

  const videoById = new Map(videoItems.map((v) => [v.id, v]));

  const items = slice.map((x) =>
    x.type === "post"
      ? { type: "post", post: postItems.get(x.row.id) }
      : { type: "video", video: videoById.get(x.row.id) }
  );

  const body = JSON.stringify({
    ok: true,
    page,
    size,
    total: merged.length,
    feed: "mixed",
    items,
  });

  // 游客这一份顺手写回缓存:接下来的 30 秒里别人再进来直接读 KV,不碰数据库。
  // 用 waitUntil 在后台写,不占这次请求的响应时间
  if (guestKey && env.STORY_KV) {
    const put = env.STORY_KV.put(guestKey, body, { expirationTtl: GUEST_TTL }).catch(() => {});
    if (waitUntil) waitUntil(put);
    else await put;
  }

  return jsonNoStore(body, guestKey ? { "x-feed-cache": "miss" } : undefined);
}
