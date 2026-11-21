/* ============================================================
   前台公开配置
   GET /api/auth/config → { turnstileSiteKey }
   site key 本来就是公开的;后台绑定了 TURNSTILE_SITE_KEY 之后,
   登录 / 注册页才会挂出人机验证(空串 = 没开)
   ============================================================ */

import { json } from "../_utils.js";

export function onRequestGet({ env }) {
  return json({
    ok: true,
    turnstileSiteKey: String((env && env.TURNSTILE_SITE_KEY) || ""),
  });
}
