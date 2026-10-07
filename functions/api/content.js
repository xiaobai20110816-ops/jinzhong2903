/* ============================================================
   103 · 站点内容接口
   GET /api/content              读全部板块(公开,页面渲染用)
   PUT /api/content { key, value } 改一个板块(服主 / 管理员)

   板块:site 文案 / announcements 公告 / students 学生 / dorms 宿舍 / moments 高光
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff } from "./_utils.js";
import { CONTENT_KEYS, ensureContent, readAllContent, writeContent } from "./_content.js";

/* 站点内容对谁都一样,不带个人状态,所以可以整份丢进边缘缓存。
   这个接口每个页面进来都要问一次,又是四五次数据库查询,是仅次于
   首页合并流的热点;缓存住之后全班刷新都走缓存。
   后台一改就顺手把缓存删掉,不影响「保存完立刻生效」。
   KV 的读有 60 秒负缓存,当缓存不靠谱,所以用 Cache API。 */
const CACHE_TTL = 60;

function cacheKeyFor(request) {
  if (typeof caches === "undefined") return null;
  return new Request(new URL(request.url).origin + "/api/content-cache");
}

function jsonNoStore(body, extra) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extra || {}),
    },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");

  const key = cacheKeyFor(request);
  if (key) {
    const hit = await caches.default.match(key).catch(() => null);
    if (hit) return jsonNoStore(await hit.text(), { "x-content-cache": "hit" });
  }

  await ensureSchema(env.DB);
  await ensureContent(env.DB);

  const content = await readAllContent(env.DB);
  const body = JSON.stringify({ ok: true, keys: CONTENT_KEYS, content });

  if (key) {
    const stored = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, s-maxage=" + CACHE_TTL + ", max-age=" + CACHE_TTL,
      },
    });
    await caches.default.put(key, stored).catch(() => {});
  }

  return jsonNoStore(body, key ? { "x-content-cache": "miss" } : undefined);
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
    // 改完把边缘缓存删掉,别人下一次进来就是新的
    const ck = cacheKeyFor(request);
    if (ck) await caches.default.delete(ck).catch(() => {});
    return json({ ok: true, ...saved });
  } catch (err) {
    return fail(err.message || "保存失败了，稍后再试");
  }
}
