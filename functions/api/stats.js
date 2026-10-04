/* ============================================================
   103 纪事 · 用量看板
   GET  /api/stats   读统计(服主 / 管理员)
   POST /api/stats   存或清除 Cloudflare API Token(仅服主)

   分两套数据:
   1) 站内自建 —— 拜访量、最热页面、每天的新增内容,全在 D1 里,不用任何配置
   2) Cloudflare 官方 —— 真实的全量请求数,需要服主贴一个只读 Token
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  dayKey,
  ROLE_OWNER,
  getSetting,
  putSetting,
  delSetting,
} from "./_utils.js";

const DAYS = 30;
/* 用户的 Cloudflare 账号(2026-10-01 新建那个)。没单独配就用它 */
const CF_ACCOUNT_FALLBACK = "2bb27ee5aa6faadbcc0cb6fefa21351f";

/* 最近 N 天的日期,从早到晚,用来把稀疏的查询结果补成连续的曲线 */
function recentDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(Date.now(), -i));
  return out;
}

/* 按天分组的结果 → 和 days 对齐的数字数组 */
function alignByDay(days, rows) {
  const map = new Map();
  for (const r of rows || []) map.set(r.day, Number(r.n) || 0);
  return days.map((d) => map.get(d) || 0);
}

/* 一条按天分组的查询,统一在这里拼:表不同、条件不同,形状一样 */
async function groupByDay(db, sql, since, days) {
  try {
    const { results } = await db.prepare(sql).bind(since).all();
    return alignByDay(days, results);
  } catch (e) {
    return days.map(() => 0);
  }
}

/* 内容按天统计:帖子表里主帖 / 回复 / 留言墙分别数 */
const SQL_POSTS_DAY = (cond) =>
  `SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day, COUNT(*) AS n
     FROM posts
    WHERE created_at >= ? AND ${cond}
    GROUP BY day`;

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("这个只有服主和管理员能看", 403);

  const days = recentDays(DAYS);
  const sinceDay = days[0];
  const sinceMs = Date.now() - (DAYS - 1) * 86400000;

  const [
    pv, uv, mainPosts, replies, wallPosts, newUsers, newLikes,
  ] = await Promise.all([
    groupByDay(env.DB, "SELECT day, SUM(hits) AS n FROM pageviews WHERE day >= ? GROUP BY day", sinceDay, days),
    groupByDay(env.DB, "SELECT day, COUNT(*) AS n FROM daily_visitors WHERE day >= ? GROUP BY day", sinceDay, days),
    groupByDay(env.DB, SQL_POSTS_DAY("parent_id IS NULL AND wall_id IS NULL"), sinceMs, days),
    groupByDay(env.DB, SQL_POSTS_DAY("parent_id IS NOT NULL"), sinceMs, days),
    groupByDay(env.DB, SQL_POSTS_DAY("wall_id IS NOT NULL"), sinceMs, days),
    groupByDay(
      env.DB,
      `SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day, COUNT(*) AS n
         FROM users WHERE created_at >= ? GROUP BY day`,
      sinceMs,
      days
    ),
    groupByDay(
      env.DB,
      `SELECT date(created_at / 1000, 'unixepoch', '+8 hours') AS day, COUNT(*) AS n
         FROM profile_likes WHERE created_at >= ? GROUP BY day`,
      sinceMs,
      days
    ),
  ]);

  // 最热页面:这一个月里被看得最多的前 12 个
  const topRows = await env.DB.prepare(
    `SELECT path, SUM(hits) AS n FROM pageviews WHERE day >= ? GROUP BY path ORDER BY n DESC LIMIT 12`
  )
    .bind(sinceDay)
    .all()
    .catch(() => ({ results: [] }));

  // 总量:各表一共多少行
  const totals = { users: 0, mainPosts: 0, replies: 0, wallPosts: 0, likes: 0, images: 0 };
  try {
    const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    totals.users = (u && u.n) || 0;

    const p = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN parent_id IS NULL AND wall_id IS NULL THEN 1 ELSE 0 END) AS main,
         SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS replies,
         SUM(CASE WHEN wall_id IS NOT NULL THEN 1 ELSE 0 END) AS wall
       FROM posts`
    ).first();
    totals.mainPosts = (p && p.main) || 0;
    totals.replies = (p && p.replies) || 0;
    totals.wallPosts = (p && p.wall) || 0;

    const l = await env.DB.prepare("SELECT COUNT(*) AS n FROM profile_likes").first();
    totals.likes = (l && l.n) || 0;
  } catch (e) { /* 表刚建好还没数据,给 0 就行 */ }

  // 图片存在 KV 里,列一次 key 就能数出张数(上限一次 1000 个)
  if (env.STORY_KV) {
    try {
      const list = await env.STORY_KV.list({ limit: 1000 });
      totals.images = (list.keys || []).length;
    } catch (e) { /* KV 没绑上就显示 0 */ }
  }

  return json({
    ok: true,
    days,
    traffic: { pv, uv },
    activity: { posts: mainPosts, replies, wall: wallPosts, users: newUsers, likes: newLikes },
    topPages: (topRows.results || []).map((r) => ({ path: r.path, hits: Number(r.n) || 0 })),
    totals,
    accounts: await accountStats(env.DB),
    cloudflare: await cloudflareUsage(env.DB),
  });
}

/* ============================================================
   账号统计:注册与新增 / 实名进度 / 活跃 / 角色与状态
   全用聚合查询一次算完,不额外建表
   ============================================================ */

/* 北京时间某天的 0 点(毫秒) */
function bjDayStart(offsetDays) {
  const d = dayKey(Date.now(), offsetDays || 0);
  return Date.parse(d + "T00:00:00+08:00");
}

async function accountStats(db) {
  const todayStart = bjDayStart(0);
  const weekStart = bjDayStart(-6); // 含今天共 7 天

  const out = {
    total: 0, today: 0, week: 0,
    verified: 0, pending: 0, none: 0,
    todayLogin: 0, weekLogin: 0,
    banned: 0, owner: 0, admin: 0, member: 0,
  };

  try {
    const u = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week,
                SUM(CASE WHEN IFNULL(verified, 0) = 1 THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN IFNULL(verified, 0) = 0 AND TRIM(IFNULL(real_name, '')) <> '' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN IFNULL(verified, 0) = 0 AND TRIM(IFNULL(real_name, '')) = '' THEN 1 ELSE 0 END) AS none,
                SUM(CASE WHEN IFNULL(banned, 0) = 1 THEN 1 ELSE 0 END) AS banned,
                SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owner,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin,
                SUM(CASE WHEN IFNULL(role, 'member') NOT IN ('owner', 'admin') THEN 1 ELSE 0 END) AS member
           FROM users`
      )
      .bind(todayStart, weekStart)
      .first();
    if (u) for (const k of Object.keys(out)) out[k] = Number(u[k]) || 0;
  } catch (e) { /* 表还没建好就全 0 */ }

  // 活跃:按会话的创建时间(即登录时间)去重数人,不需要额外字段
  try {
    const s = await db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS today,
                COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS week
           FROM sessions`
      )
      .bind(todayStart, weekStart)
      .first();
    if (s) {
      out.todayLogin = Number(s.today) || 0;
      out.weekLogin = Number(s.week) || 0;
    }
  } catch (e) { /* 没有会话表就显示 0 */ }

  return out;
}

/* ============================================================
   Cloudflare 官方数据
   ============================================================ */

async function cloudflareUsage(db) {
  const token = await getSetting(db, "cf_api_token");
  if (!token) return { ok: false, reason: "还没配置 API Token" };
  const account = (await getSetting(db, "cf_account_id")) || CF_ACCOUNT_FALLBACK;

  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const until = new Date().toISOString();

  // Pages Functions 的调用量,按小时分组再自己汇总成天
  const query = `query Usage($account: String!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        pagesFunctionsInvocationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          sum { requests }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  let res, body;
  try {
    res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ query: query, variables: { account: account, since: since, until: until } }),
    });
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: "连不上 Cloudflare 的接口" };
  }

  const firstErr = body && body.errors && body.errors[0];
  if (firstErr) {
    return { ok: false, reason: "Cloudflare 说：" + String(firstErr.message || "查询被拒绝").slice(0, 160) };
  }
  if (!res.ok || !body || !body.data) {
    return { ok: false, reason: "Cloudflare 拒绝了这次请求（HTTP " + res.status + "），多半是 Token 权限不够" };
  }

  const acc = body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
  const groups = (acc && acc.pagesFunctionsInvocationsAdaptiveGroups) || [];

  const days = recentDays(DAYS);
  const byDay = new Map();
  let total = 0;
  for (const g of groups) {
    const n = (g.sum && g.sum.requests) || 0;
    total += n;
    const hour = g.dimensions && g.dimensions.datetimeHour;
    if (!hour) continue;
    const d = dayKey(Date.parse(hour));
    byDay.set(d, (byDay.get(d) || 0) + n);
  }

  return { ok: true, total: total, days: days, requests: days.map((d) => byDay.get(d) || 0) };
}

/* ============================================================
   配置(仅服主)
   ============================================================ */

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能操作", 401);
  if (me.role !== ROLE_OWNER) return fail("只有服主能配置这个", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  if (payload.clear) {
    await delSetting(env.DB, "cf_api_token");
    return json({ ok: true, cloudflare: { ok: false, reason: "已清除，还没配置 API Token" } });
  }

  const token = String(payload.token || "").trim();
  const account = String(payload.account || "").trim();
  if (!token) return fail("Token 不能是空的");

  await putSetting(env.DB, "cf_api_token", token);
  if (account) await putSetting(env.DB, "cf_account_id", account);

  return json({ ok: true, cloudflare: await cloudflareUsage(env.DB) });
}
