/* ============================================================
   103 纪事 · 登录
   POST /api/auth/login  { username, password }
   成功就下发 httpOnly 会话 Cookie,以后所有需要身份的接口靠它认人
   ============================================================ */

import {
  fail,
  notReady,
  ensureSchema,
  jsonWith,
  hashPassword,
  randomHex,
  sessionCookie,
  SESSION_TTL_MS,
  publicUser,
} from "../_utils.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  if (!username || !password) return fail("用户名和密码都要填");

  const row = await env.DB.prepare(
    "SELECT id, username, salt, pass_hash, role, avatar_key, signature, banned FROM users WHERE username = ?"
  )
    .bind(username)
    .first();

  // 用户名不存在和密码错误给同一句提示,别帮人试探出哪个名字已被占用
  if (!row || row.pass_hash !== (await hashPassword(password, row.salt))) {
    return fail("用户名或密码不对", 401);
  }

  // 密码对了但被封禁:明确告诉他为什么进不来,不然会以为是密码错了
  if (row.banned) return fail("这个账号已被封禁，联系服主处理", 403);

  const now = Date.now();
  const token = randomHex(32);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(token, row.id, now, now + SESSION_TTL_MS)
    .run();

  // 顺手清掉这个人已经过期的会话,别让 sessions 表一直涨
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?")
    .bind(row.id, now)
    .run()
    .catch(() => {});

  return jsonWith(
    { ok: true, user: publicUser(row) },
    { "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) }
  );
}
