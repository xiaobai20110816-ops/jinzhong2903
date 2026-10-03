/* ============================================================
   103 · 站点内容接口
   GET /api/content              读全部板块(公开,页面渲染用)
   PUT /api/content { key, value } 改一个板块(服主 / 管理员)

   板块:site 文案 / announcements 公告 / students 学生 / dorms 宿舍 / moments 高光
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff } from "./_utils.js";
import { CONTENT_KEYS, ensureContent, readAllContent, writeContent } from "./_content.js";

export async function onRequestGet({ env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureContent(env.DB);

  const content = await readAllContent(env.DB);
  return json({ ok: true, keys: CONTENT_KEYS, content });
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);
  await ensureContent(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主和管理员能改站点内容", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const key = String(payload.key || "");
  if (!CONTENT_KEYS.includes(key)) return fail("不认识的板块：" + key);

  try {
    const saved = await writeContent(env.DB, key, payload.value);
    return json({ ok: true, ...saved });
  } catch (err) {
    return fail(err.message || "保存失败了，稍后再试");
  }
}
