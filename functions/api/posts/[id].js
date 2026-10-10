/* ============================================================
   103 纪事 · 单条帖子
   GET    /api/posts/:id                     帖子详情:正文 + 全部回复 + 点赞数
   PUT    /api/posts/:id   { pinned }        服主/管理员置顶或取消置顶(只对主帖有效)
                           { visibility }    服主/管理员标记:public=未注册/未实名可见
                                             class=仅本班实名可见(只对主留言板主帖有效)
                           { body, images }  改正文 / 换图:本人或服主、管理员
   DELETE /api/posts/:id                     本人可删自己的;服主/管理员可删任意一条
                                             删主帖会连带删掉它下面所有回复及图片
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  canViewClass,
  safeParse,
  IMAGE_KEY_RE,
  toPost,
  loadThread,
  loadAuthors,
  likeCounts,
  likedBy,
  onlineUserIds,
  POST_COLS,
} from "../_utils.js";

const MAX_BODY = 4000;
const MAX_IMAGES = 3;

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

/* 帖子详情:点卡片进来看到的那一页 —— 正文、全部图片、所有评论。
   传进来的可以是主帖 id,也可以是某条回复 id(自动上溯到根帖) */
export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  const me = await currentUser(request, env);

  let root = await env.DB.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`)
    .bind(id)
    .first();
  if (!root) return fail("这条已经不在了", 404);

  // 老数据可能多层嵌套,这里一律上溯到根
  let guard = 0;
  while (root.parent_id && guard++ < 50) {
    const up = await env.DB.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`)
      .bind(root.parent_id)
      .first();
    if (!up) break;
    root = up;
  }

  // 「仅本班可见」的主帖,未注册 / 未实名的普通用户看不到(和列表口径一致)
  if (root.visibility === "class" && !canViewClass(me))
    return fail("这条内容仅限已实名的本班同学查看", 403);

  const kids = await loadThread(env.DB, [root.id]);
  const rows = [root, ...kids];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const authors = await loadAuthors(env.DB, rows, me);

  const counts = await likeCounts(env.DB, [root.id]);
  const mine = await likedBy(env.DB, me && me.id, [root.id]);
  const online = await onlineUserIds(env.DB, [root.user_id]);

  const rootAuthor = authors.get(root.user_id) || null;
  const post = {
    ...toPost(root),
    author: rootAuthor ? { ...rootAuthor, online: online.has(root.user_id) ? 1 : 0 } : null,
    likes: counts.get(root.id) || 0,
    liked: mine.has(root.id) ? 1 : 0,
    replies: [],
  };

  // 回复平铺一层,「回复 @某某」的名字同样按看的人决定给不给真名
  for (const row of kids) {
    const targetId = row.reply_to_id || row.parent_id;
    const target = rowById.get(targetId);
    const targetAuthor = target ? authors.get(target.user_id) : null;
    post.replies.push({
      ...toPost(row),
      author: authors.get(row.user_id) || null,
      reply_to_name: targetAuthor
        ? targetAuthor.display_name || targetAuthor.real_name || targetAuthor.name
        : target
        ? target.name
        : "",
      reply_to_verified: targetAuthor && targetAuthor.verified && targetAuthor.real_name ? 1 : 0,
    });
  }
  post.replies.sort((a, b) => a.created_at - b.created_at || a.id - b.id);

  return json({ ok: true, root_id: root.id, post });
}

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("帖子编号不对");

  let payload = {};
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const row = await env.DB.prepare(
    "SELECT id, parent_id, wall_id, video_id, user_id, images FROM posts WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!row) return fail("这条已经不在了", 404);

  const mine = !!row.user_id && row.user_id === me.id;
  const sets = [];
  const binds = [];

  // 置顶:只对主帖,服主 / 管理员
  if (payload.pinned !== undefined) {
    if (!isStaff(me)) return fail("只有服主和管理员能置顶", 403);
    if (row.parent_id) return fail("只能置顶主帖");
    sets.push("pinned = ?");
    binds.push(payload.pinned ? 1 : 0);
  }

  // 可见性标记:服主 / 管理员决定这条主帖给不给未注册 / 未实名的人看。
  // 只对主留言板的主帖有意义 —— 回复跟随主帖,留言墙和视频评论不在流里
  if (payload.visibility !== undefined) {
    if (!isStaff(me)) return fail("只有服主和管理员能改可见性", 403);
    if (row.parent_id || row.wall_id || row.video_id)
      return fail("只能标记主留言板里的主帖");
    sets.push("visibility = ?");
    binds.push(payload.visibility === "class" ? "class" : "public");
  }

  // 改正文 / 换图:本人或服主、管理员
  if (payload.body !== undefined || payload.images !== undefined) {
    if (!mine && !isStaff(me)) return fail("只能改自己发的，管理身份可以改任意一条", 403);

    const body = payload.body !== undefined ? String(payload.body).trim().slice(0, MAX_BODY) : null;
    const images =
      payload.images !== undefined
        ? (Array.isArray(payload.images) ? payload.images : [])
            .map(String)
            .filter((k) => IMAGE_KEY_RE.test(k))
            .slice(0, MAX_IMAGES)
        : null;

    // 改完不能变成一条既没字又没图的空帖
    const finalBody = body !== null ? body : null;
    const finalImages = images !== null ? images : safeParse(row.images);
    if (body !== null && !finalBody && !finalImages.length) {
      return fail("写点什么，或者放张图吧");
    }

    if (body !== null) {
      sets.push("body = ?");
      binds.push(body);
    }
    if (images !== null) {
      sets.push("images = ?");
      binds.push(JSON.stringify(images));
    }
  }

  if (!sets.length) return fail("没有要改的内容");

  binds.push(id);
  await env.DB.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  return json({ ok: true, id, visibility: payload.visibility === "class" ? "class" : "public" });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

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

  // 帖子没了,挂在它上面的赞也别留着(免得计数越攒越乱)
  await env.DB.prepare(`DELETE FROM post_likes WHERE post_id IN (${holes})`)
    .bind(...ids)
    .run()
    .catch(() => {});

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
