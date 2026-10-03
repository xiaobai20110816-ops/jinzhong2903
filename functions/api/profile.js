/* ============================================================
   103 纪事 · 个人中心
   POST /api/profile  { signature, avatar_key }
   改自己的个性签名和头像;头像先走 /api/upload 拿到 key 再传进来
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, IMAGE_KEY_RE } from "./_utils.js";

const MAX_SIGNATURE = 40;

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

  const signature = String(payload.signature ?? "").trim().slice(0, MAX_SIGNATURE);
  const avatarKey = String(payload.avatar_key ?? "").trim();

  // 头像要么清空,要么必须是我们自己上传时生成的那种 key
  if (avatarKey && !IMAGE_KEY_RE.test(avatarKey)) return fail("头像地址不对，重新传一次吧");

  const old = await env.DB.prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(me.id)
    .first();

  await env.DB.prepare("UPDATE users SET signature = ?, avatar_key = ? WHERE id = ?")
    .bind(signature, avatarKey || null, me.id)
    .run();

  // 换头像了,把旧图从 KV 里清掉,别白占免费额度
  const stale = old && old.avatar_key;
  if (stale && stale !== avatarKey && IMAGE_KEY_RE.test(stale) && env.STORY_KV) {
    await env.STORY_KV.delete("img:" + stale).catch(() => {});
  }

  return json({ ok: true, user: { ...me, signature, avatar: avatarKey } });
}
