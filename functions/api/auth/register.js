/* ============================================================
   103 纪事 · 注册
   POST /api/auth/register  { username, password, cid }
   完全自由注册:起个名字 + 设个密码就能用。
   注册成功直接算登录,顺手下发 httpOnly 会话 Cookie。
   ============================================================ */

import {
  fail,
  notReady,
  ensureSchema,
  ensureOwner,
  jsonWith,
  hashPassword,
  randomHex,
  USERNAME_RE,
  sessionCookie,
  SESSION_TTL_MS,
  publicUser,
} from "../_utils.js";

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 64;
const REG_COOLDOWN_MS = 20000; // 同一台设备 20 秒内只能注册一次,挡批量脚本

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureOwner(env.DB, env);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  const cid = String(payload.cid || "").slice(0, 64);

  if (!USERNAME_RE.test(username)) {
    return fail("用户名 2~16 位，中文、字母、数字、下划线都可以");
  }
  if (password.length < MIN_PASSWORD) return fail(`密码至少 ${MIN_PASSWORD} 位`);
  if (password.length > MAX_PASSWORD) return fail("密码太长了，换短一点的");

  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first();
  if (exists) return fail("这个名字已经有人用了，换一个吧", 409);

  const now = Date.now();

  if (cid) {
    const last = await env.DB.prepare(
      "SELECT created_at FROM users WHERE cid = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(cid)
      .first();
    if (last && now - last.created_at < REG_COOLDOWN_MS) {
      return fail("注册得有点快啦，稍等一下再试", 429);
    }
  }

  const salt = randomHex(8);
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO users (username, salt, pass_hash, avatar_key, signature, role, cid, created_at)
       VALUES (?, ?, ?, NULL, '', 'member', ?, ?)`
    )
      .bind(username, salt, await hashPassword(password, salt), cid, now)
      .run();
  } catch (e) {
    // 同名的两个请求同时进来时,唯一索引会挡下后一个
    return fail("这个名字已经有人用了，换一个吧", 409);
  }

  const id = res.meta.last_row_id;
  const token = randomHex(32);
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(token, id, now, now + SESSION_TTL_MS)
    .run();

  return jsonWith(
    { ok: true, user: publicUser({ id, username, role: "member", avatar_key: "", signature: "" }) },
    { "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) }
  );
}
