/* ============================================================
   103 纪事 · 我是谁
   GET /api/auth/me   返回当前登录账号,没登录就 user: null
   前端每次打开页面问一次,用来决定导航栏和发帖框的样子
   ============================================================ */

import { json, ensureSchema, ensureOwner, currentUser, notReady } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureOwner(env.DB, env);

  const user = await currentUser(request, env);
  return json({ ok: true, user });
}
