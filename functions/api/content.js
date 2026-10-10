/* ============================================================
   103 · 站点内容接口
   GET /api/content              读全部板块(宿舍板块只给已实名同学)
   PUT /api/content { key, value } 改一个板块(服主 / 管理员)

   板块:site 文案 / announcements 公告 / students 学生 / dorms 宿舍 / moments 高光
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, isStaff, canViewClass } from "./_utils.js";
import { CONTENT_KEYS, ensureContent, readAllContent, writeContent } from "./_content.js";

/* 站点内容对谁都一样,不带个人状态,所以可以整份丢进边缘缓存。
   这个接口每个页面进来都要问一次,又是四五次数据库查询,是仅次于
   首页合并流的热点;缓存住之后全班刷新都走缓存。
   后台一改就顺手把缓存删掉,不影响「保存完立刻生效」。
   KV 的读有 60 秒负缓存,当缓存不靠谱,所以用 Cache API。

   唯一的例外是宿舍板块(dorms):宿舍风采只给已实名的本班同学看,
   所以缓存分两份 —— 实名版全量,gated 版剥掉 dorms。
   认人让缓存命中路径多了一次会话查询,换来的是两份缓存永不串号。 */
const CACHE_TTL = 60;

function cacheKeyFor(request, allowed) {
  if (typeof caches === "undefined") return null;
  return new Request(
    new URL(request.url).origin + (allowed ? "/api/content-cache" : "/api/content-cache-gated")
  );
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

  const me = await currentUser(request, env).catch(() => null);
  const allowed = canViewClass(me);

  const key = cacheKeyFor(request, allowed);
  if (key) {
    const hit = await caches.default.match(key).catch(() => null);
    if (hit) return jsonNoStore(await hit.text(), { "x-content-cache": "hit" });
  }

  await ensureSchema(env.DB);
  await ensureContent(env.DB);

  let content = await readAllContent(env.DB);
  // 未注册 / 未实名:宿舍数据直接掐断,页面上由前端门禁兜住
  if (!allowed) content = { ...content, dorms: [] };

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
    // 改完把两份边缘缓存(实名版 / gated 版)都删掉,别人下一次进来就是新的
    for (const allowed of [true, false]) {
      const ck = cacheKeyFor(request, allowed);
      if (ck) await caches.default.delete(ck).catch(() => {});
    }
    return json({ ok: true, ...saved });
  } catch (err) {
    return fail(err.message || "保存失败了，稍后再试");
  }
}
