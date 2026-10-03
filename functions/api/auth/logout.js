/* ============================================================
   103 纪事 · 退出登录
   POST /api/auth/logout
   删掉库里的会话,并把浏览器上的 Cookie 过期掉
   ============================================================ */

import { jsonWith, readCookie, clearCookie, COOKIE_NAME } from "../_utils.js";

export async function onRequestPost({ request, env }) {
  const token = readCookie(request, COOKIE_NAME);
  if (token && env.DB) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?")
      .bind(token)
      .run()
      .catch(() => {
        /* 删不掉也照样把 Cookie 清掉,不让用户卡在登录态 */
      });
  }
  return jsonWith({ ok: true }, { "set-cookie": clearCookie() });
}
