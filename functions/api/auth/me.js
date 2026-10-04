/* ============================================================
   103 纪事 · 我是谁
   GET /api/auth/me   返回当前登录账号,没登录就 user: null
   前端每次打开页面问一次,用来决定导航栏和发帖框的样子
   ============================================================ */

import { json, ensureSchema, currentUser, notReady, recordView } from "../_utils.js";

export async function onRequestGet({ request, env, waitUntil }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const user = await currentUser(request, env);
  // 页面浏览统计顺便在这记一笔:前端会带上 ?p=当前路径。
  // 丢给 waitUntil 后台执行,不占用这次请求的时间
  recordView(env, request, user, waitUntil);
  return json({ ok: true, user });
}
