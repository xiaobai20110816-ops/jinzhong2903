/* ============================================================
   103 纪事 · 账号安全:改密码 / 改用户名
   POST /api/auth/security
     { action: "password", oldPassword, newPassword }
     { action: "username", password, username }
   两个动作都要求先验证当前密码,防止别人拿你忘退的设备乱改。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  hashPassword,
  randomHex,
  readCookie,
  COOKIE_NAME,
  USERNAME_RE,
} from "../_utils.js";

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 64;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const action = String(payload.action || "").trim();

  // 两个动作都要拿库里最新的 salt/hash 验当前密码
  const row = await env.DB.prepare("SELECT id, username, salt, pass_hash FROM users WHERE id = ?")
    .bind(me.id)
    .first();
  if (!row) return fail("账号状态异常，重新登录再试", 401);

  /* ---------- 改密码 ---------- */
  if (action === "password") {
    const oldPassword = String(payload.oldPassword || "");
    const newPassword = String(payload.newPassword || "");
    if (!oldPassword || !newPassword) return fail("旧密码和新密码都要填");
    if (newPassword.length < MIN_PASSWORD) return fail(`新密码至少 ${MIN_PASSWORD} 位`);
    if (newPassword.length > MAX_PASSWORD) return fail("新密码太长了，换短一点的");
    if (oldPassword === newPassword) return fail("新密码和旧密码一样，不用改");

    if (row.pass_hash !== (await hashPassword(oldPassword, row.salt))) {
      return fail("旧密码不对，想清楚再输", 403);
    }

    // 换新盐,旧哈希直接作废
    const salt = randomHex(8);
    await env.DB.prepare("UPDATE users SET salt = ?, pass_hash = ? WHERE id = ?")
      .bind(salt, await hashPassword(newPassword, salt), row.id)
      .run();

    // 改了密码,把这个人其它设备上的会话全部踢下线,只留当前这一条
    const token = readCookie(request, COOKIE_NAME);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
        .bind(row.id, token)
        .run()
        .catch(() => {});
    }

    return json({ ok: true });
  }

  /* ---------- 改用户名 ---------- */
  if (action === "username") {
    const password = String(payload.password || "");
    const username = String(payload.username || "").trim();
    if (!password || !username) return fail("新用户名和当前密码都要填");
    if (!USERNAME_RE.test(username)) {
      return fail("用户名 2~16 位，中文、字母、数字、下划线都可以");
    }
    if (username === row.username) return fail("新用户名和现在的一样，不用改");

    if (row.pass_hash !== (await hashPassword(password, row.salt))) {
      return fail("当前密码不对，想清楚再输", 403);
    }

    const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(username)
      .first();
    if (exists) return fail("这个名字已经有人用了，换一个吧", 409);

    try {
      await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?")
        .bind(username, row.id)
        .run();
    } catch (e) {
      // 两个请求同时抢同一个名字时,唯一索引挡下后一个
      return fail("这个名字已经有人用了，换一个吧", 409);
    }

    // 发帖时冗余存了一份发帖人名字,跟着改,不然老帖子上还是旧名
    await env.DB.prepare("UPDATE posts SET name = ? WHERE user_id = ?")
      .bind(username, row.id)
      .run()
      .catch(() => {});

    return json({ ok: true, user: { ...me, name: username } });
  }

  return fail("不支持的操作", 400);
}
