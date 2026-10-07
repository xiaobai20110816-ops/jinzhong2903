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
import { b2Config, s3Usage } from "./_b2.js";

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
  const totals = {
    users: 0, mainPosts: 0, replies: 0, wallPosts: 0, likes: 0, images: 0,
    galleryCount: 0, galleryBytes: 0,
  };
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

  // 图库专属用量:直接数 D1 里的元数据,不依赖 Cloudflare Token。
  // KV 官方存储字节数只有配了 API Token 才读得到,而这里任何时候都能给一个准数。
  try {
    const g = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(full_size), 0) AS b FROM gallery"
    ).first();
    totals.galleryCount = Number((g && g.n) || 0);
    totals.galleryBytes = Number((g && g.b) || 0);
  } catch (e) { /* gallery 表还没建好就先给 0 */ }

  // 图片存在 KV 里,列一次 key 就能数出张数(上限一次 1000 个)
  if (env.STORY_KV) {
    try {
      const list = await env.STORY_KV.list({ limit: 1000 });
      totals.images = (list.keys || []).length;
    } catch (e) { /* KV 没绑上就显示 0 */ }
  }

  // Cloudflare 那几块只查一次,官方用量和免费额度对照共用同一份结果
  const cloudflare = await cloudflareUsage(env.DB);
  const d1Bytes = await d1SelfSize(env.DB);
  const b2 = await b2Usage(env);

  return json({
    ok: true,
    days,
    traffic: { pv, uv },
    activity: { posts: mainPosts, replies, wall: wallPosts, users: newUsers, likes: newLikes },
    topPages: (topRows.results || []).map((r) => ({ path: r.path, hits: Number(r.n) || 0 })),
    totals,
    accounts: await accountStats(env.DB),
    cloudflare: cloudflare,
    b2: b2,
    quota: quotaGroups(cloudflare, d1Bytes, totals.galleryBytes, totals.galleryCount, b2),
  });
}

/* B2 存储用量。B2 不是 Cloudflare 的资源,官方用量接口里没有,
   只能拿 SigV4 去把桶列一遍。接不上 / 列不动就返回原因,不抛错——
   看板宁可少一块数据,也不该整页打不开 */
async function b2Usage(env) {
  const cfg = await b2Config(env, env.DB).catch(() => null);
  const blank = {
    ok: false,
    ready: false,
    reason: "还没接上：到「B2 配置」页签填专用密钥",
    bucket: (cfg && cfg.bucket) || "",
    endpoint: "",
    objects: null,
    bytes: null,
    videos: null,
    images: null,
    truncated: false,
  };
  if (!cfg || !cfg.ready) return blank;

  try {
    const u = await s3Usage(cfg);
    return {
      ok: true,
      ready: true,
      reason: u.truncated ? "对象太多，只数了前 1 万个" : "",
      bucket: cfg.bucket,
      endpoint: String(cfg.endpoint).replace(/^https?:\/\//i, ""),
      objects: u.objects,
      bytes: u.bytes,
      videos: (u.byPrefix.video && u.byPrefix.video.bytes) || 0,
      images: (u.byPrefix.img && u.byPrefix.img.bytes) || 0,
      truncated: !!u.truncated,
    };
  } catch (e) {
    return Object.assign({}, blank, {
      ready: true,
      reason: e.message || "列桶失败",
      endpoint: String(cfg.endpoint).replace(/^https?:\/\//i, ""),
    });
  }
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
   Cloudflare 官方数据 + 免费额度对照
   ============================================================ */

/* 免费版(Workers Free / Pages Free)的各项上限。单位写在注释里。
   套餐或额度一变,改这里就行 —— 前端所有进度条都按这份数据画 */
const FREE = {
  requests: 100000,                    // Workers / Pages Functions:请求数 / 天
  d1Read: 5000000,                     // D1:读行数 / 天
  d1Write: 100000,                     // D1:写行数 / 天
  d1Total: 5 * 1024 * 1024 * 1024,     // D1:账号总存储 5 GB(单库另限 500 MB)
  kvStore: 1024 * 1024 * 1024,         // KV:账号总存储 1 GB
  kvRead: 100000,                      // KV:读 / 天
  kvWrite: 1000,                       // KV:写 / 天
  kvDelete: 1000,                      // KV:删 / 天
  kvList: 1000,                        // KV:列举 / 天
  b2Store: 10 * 1024 * 1024 * 1024,    // B2:免费额度 10 GB 存储(下载流量免费)
  builds: 500,                         // Pages:构建次数 / 月
  files: 20000,                        // Pages:站点文件数
  fileSize: 25 * 1024 * 1024,          // Pages:单个文件 25 MiB
  domains: 100,                        // Pages:自定义域名 / 项目
};

/* 一次 GraphQL 查询:出错就抛,由外面的 safeQuery 兜住 */
async function cfQuery(token, query, variables) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ query: query, variables: variables }),
  });
  const body = await res.json().catch(() => null);
  const err = body && body.errors && body.errors[0];
  if (err) throw new Error(String(err.message || "查询被拒绝").slice(0, 180));
  if (!res.ok || !body || !body.data) {
    throw new Error("HTTP " + res.status + "，多半是 Token 权限不够");
  }
  return body.data;
}

/* 一个数据集查不到不该拖垮别的:各自单独跑,失败只记自己那句原因 */
async function safeQuery(promise) {
  try {
    return { ok: true, data: await promise };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 180) };
  }
}

function firstAccount(data) {
  return (data && data.viewer && data.viewer.accounts && data.viewer.accounts[0]) || {};
}

/* ---- 各数据集只挑我们要的字段,别的都不要(越小越快) ---- */
const PAGES_Q = `query Usage($account: String!, $since: Time!, $until: Time!) {
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

const D1_ROWS_Q = `query D1Rows($account: String!, $day: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

const D1_SIZE_Q = `query D1Size($account: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1StorageAdaptiveGroups(limit: 10000) {
        max { databaseSizeBytes }
        dimensions { date databaseId }
      }
    }
  }
}`;

const KV_OPS_Q = `query KvOps($account: String!, $day: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

const KV_SIZE_Q = `query KvSize($account: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      kvStorageAdaptiveGroups(limit: 10000) {
        max { byteCount keyCount }
        dimensions { namespaceId }
      }
    }
  }
}`;

async function cloudflareUsage(db) {
  const token = await getSetting(db, "cf_api_token");
  if (!token) return { ok: false, configured: false, reason: "还没配置 API Token" };
  const account = (await getSetting(db, "cf_account_id")) || CF_ACCOUNT_FALLBACK;

  const now = Date.now();
  const since = new Date(now - DAYS * 86400000).toISOString();
  const until = new Date(now).toISOString();
  // 免费额度按 UTC 当天 0 点重置,所以「今天」也按 UTC 算
  const today = new Date(now).toISOString().slice(0, 10);

  // 五块并行查:任何一块挂掉,其余照常显示
  const [pages, d1Rows, d1Size, kvOps, kvSize] = await Promise.all([
    safeQuery(cfQuery(token, PAGES_Q, { account: account, since: since, until: until })),
    safeQuery(cfQuery(token, D1_ROWS_Q, { account: account, day: today })),
    safeQuery(cfQuery(token, D1_SIZE_Q, { account: account })),
    safeQuery(cfQuery(token, KV_OPS_Q, { account: account, day: today })),
    safeQuery(cfQuery(token, KV_SIZE_Q, { account: account })),
  ]);

  // ---- Pages Functions:30 天曲线 + 今天这一格 ----
  const days = recentDays(DAYS);
  const byDay = new Map();
  let total = 0;
  let todayReq = null;
  let pagesErr = "";
  if (pages.ok) {
    const groups = firstAccount(pages.data).pagesFunctionsInvocationsAdaptiveGroups || [];
    for (const g of groups) {
      const n = (g.sum && g.sum.requests) || 0;
      total += n;
      const hour = g.dimensions && g.dimensions.datetimeHour;
      if (!hour) continue;
      const t = Date.parse(hour);
      byDay.set(dayKey(t), (byDay.get(dayKey(t)) || 0) + n);
      if (new Date(t).toISOString().slice(0, 10) === today) todayReq = (todayReq || 0) + n;
    }
    if (todayReq === null) todayReq = 0;
  } else {
    pagesErr = pages.reason;
  }

  // ---- D1:今天的读写行数 + 各库最新一次快照的大小 ----
  const d1 = { ok: false, reason: "", rowsRead: null, rowsWritten: null, bytes: null, dbs: 0 };
  if (d1Rows.ok) {
    let r = 0, w = 0;
    for (const g of firstAccount(d1Rows.data).d1AnalyticsAdaptiveGroups || []) {
      r += (g.sum && g.sum.rowsRead) || 0;
      w += (g.sum && g.sum.rowsWritten) || 0;
    }
    d1.rowsRead = r;
    d1.rowsWritten = w;
    d1.ok = true;
  } else {
    d1.reason = d1Rows.reason;
  }
  if (d1Size.ok) {
    // 同一个库保留日期最新的那条快照,再把各库相加,免得同一天的多条被重复累加
    const latest = new Map();
    for (const g of firstAccount(d1Size.data).d1StorageAdaptiveGroups || []) {
      const dim = g.dimensions || {};
      const key = dim.databaseId || "db";
      const prev = latest.get(key);
      if (!prev || String(dim.date || "") >= String(prev.date || "")) {
        latest.set(key, { date: dim.date || "", size: (g.max && g.max.databaseSizeBytes) || 0 });
      }
    }
    let bytes = 0;
    for (const v of latest.values()) bytes += v.size;
    d1.bytes = bytes;
    d1.dbs = latest.size;
    d1.ok = true;
  } else if (!d1.reason) {
    d1.reason = d1Size.reason;
  }

  // ---- KV:今天的读/写/删/列 + 存储 ----
  const kv = {
    ok: false, reason: "", reads: null, writes: null,
    deletes: null, lists: null, bytes: null, keys: 0, namespaces: 0,
  };
  if (kvOps.ok) {
    const byType = new Map();
    for (const g of firstAccount(kvOps.data).kvOperationsAdaptiveGroups || []) {
      const t = String((g.dimensions && g.dimensions.actionType) || "").toLowerCase();
      byType.set(t, (byType.get(t) || 0) + ((g.sum && g.sum.requests) || 0));
    }
    kv.reads = byType.get("read") || 0;
    kv.writes = byType.get("write") || 0;
    kv.deletes = byType.get("delete") || 0;
    kv.lists = byType.get("list") || 0;
    kv.ok = true;
  } else {
    kv.reason = kvOps.reason;
  }
  if (kvSize.ok) {
    let bytes = 0, keys = 0;
    const seen = new Set();
    for (const g of firstAccount(kvSize.data).kvStorageAdaptiveGroups || []) {
      const id = (g.dimensions && g.dimensions.namespaceId) || "kv";
      if (seen.has(id)) continue; // 一个命名空间只算一次
      seen.add(id);
      bytes += (g.max && g.max.byteCount) || 0;
      keys += (g.max && g.max.keyCount) || 0;
    }
    kv.bytes = bytes;
    kv.keys = keys;
    kv.namespaces = seen.size;
    kv.ok = true;
  } else if (!kv.reason) {
    kv.reason = kvSize.reason;
  }

  return {
    ok: !pagesErr, // 这块只决定「官方请求曲线」能不能画
    configured: true,
    reason: pagesErr,
    total: total,
    days: days,
    requests: days.map((d) => byDay.get(d) || 0),
    todayRequests: todayReq,
    today: today,
    d1: d1,
    kv: kv,
  };
}

/* ============================================================
   免费额度对照:把「已用 / 上限」整理成前端直接能画的样子
   ============================================================ */

/* used = null 表示这次没取到,前端只显示上限 */
function quotaItem(label, used, limit, fmt, hint) {
  const pct = used == null || !limit ? null : Math.min(100, (used / limit) * 100);
  return { label: label, used: used == null ? null : used, limit: limit, fmt: fmt, percent: pct, hint: hint || "" };
}

function quotaGroups(cf, selfBytes, galleryBytes, galleryCount, b2) {
  const d1 = (cf && cf.d1) || {};
  const kv = (cf && cf.kv) || {};
  const cfOk = !!(cf && cf.ok);
  const cfWhy = (cf && cf.reason) || "还没配置 API Token";
  // 已经配了 Token 却读不到,才值得把原因亮出来;一个字都没配就统一在上面提示
  const warnOn = !!(cf && cf.configured);
  const b2x = b2 || { ok: false, ready: false, reason: "还没接上 B2 存储" };
  const b2Why = b2x.reason || "";

  // D1 占用优先用 D1 自己报的那个数(不需要 Token、随时都准),没有再退回官方接口
  const d1Bytes = selfBytes != null ? selfBytes : (d1.ok ? d1.bytes : null);
  const d1Hint = selfBytes != null ? "由 D1 自身页大小算出" : "";

  return [
    {
      name: "Workers · Pages Functions",
      note: "每访问一次 /api/... 就算一次请求。免费版 10 万次/天，按 UTC 0 点重置。",
      warn: warnOn && !cfOk ? cfWhy : "",
      items: [quotaItem("今日请求数", cfOk ? cf.todayRequests : null, FREE.requests, "int", cfOk ? "" : cfWhy)],
    },
    {
      name: "D1 数据库",
      note: "免费版：读 500 万行/天，写 10 万行/天，账号总存储 5 GB（单个库最大 500 MB）。",
      warn: warnOn && !d1.ok ? d1.reason : "",
      items: [
        quotaItem("今日读行数", d1.ok ? d1.rowsRead : null, FREE.d1Read, "int", d1.ok ? "" : d1.reason),
        quotaItem("今日写行数", d1.ok ? d1.rowsWritten : null, FREE.d1Write, "int", d1.ok ? "" : d1.reason),
        quotaItem("存储占用", d1Bytes, FREE.d1Total, "bytes", d1Hint || (d1.ok ? "" : d1.reason)),
      ],
    },
    {
      name: "KV 图片库",
      note: "免费版：读 10 万/天，写、删、列举各 1000/天，账号总存储 1 GB。「图库占用」不用 Token 也能看到。",
      warn: warnOn && !kv.ok ? kv.reason : "",
      items: [
        quotaItem(
          "图库占用（自算）",
          galleryBytes == null ? null : galleryBytes,
          FREE.kvStore,
          "bytes",
          "按 D1 里记录的原图累计，不用 Token 也能看到" +
            (galleryCount ? "；共 " + galleryCount + " 张" : "（还没传过图）") +
            "。不含缩略图与帖子图片"
        ),
        quotaItem("今日读次数", kv.ok ? kv.reads : null, FREE.kvRead, "int", kv.ok ? "" : kv.reason),
        quotaItem("今日写次数", kv.ok ? kv.writes : null, FREE.kvWrite, "int", kv.ok ? "" : kv.reason),
        quotaItem("今日删次数", kv.ok ? kv.deletes : null, FREE.kvDelete, "int", kv.ok ? "" : kv.reason),
        quotaItem("今日列举次数", kv.ok ? kv.lists : null, FREE.kvList, "int", kv.ok ? "" : kv.reason),
        quotaItem("存储占用（官方）", kv.ok ? kv.bytes : null, FREE.kvStore, "bytes", kv.ok ? "" : kv.reason),
      ],
    },
    {
      name: "B2 对象存储",
      note:
        "视频和超过 KV 上限的原图都存这儿。" +
        "免费额度 10 GB 存储、下载流量免费（B2 是 Cloudflare Bandwidth Alliance 成员，回源这段不计费）。" +
        (b2x.bucket ? "当前桶：" + b2x.bucket : ""),
      warn: b2x.ready && !b2x.ok ? b2Why : "",
      items: [
        quotaItem(
          "已用存储",
          b2x.ok ? b2x.bytes : null,
          FREE.b2Store,
          "bytes",
          b2x.ok ? "共 " + b2x.objects + " 个文件" + (b2x.truncated ? "（是前 1 万个的合计）" : "") : b2Why
        ),
        quotaItem("其中视频", b2x.ok ? b2x.videos : null, FREE.b2Store, "bytes", b2x.ok ? "" : b2Why),
        quotaItem("其中图片", b2x.ok ? b2x.images : null, FREE.b2Store, "bytes", b2x.ok ? "" : b2Why),
        quotaItem("文件总数", b2x.ok ? b2x.objects : null, 0, "int", b2x.ok ? "" : b2Why),
      ],
    },
    {
      name: "Pages 站点（参考上限）",
      note: "这几项 Cloudflare 不开放用量接口，只把免费版的上限列出来供参考。",
      items: [
        quotaItem("构建次数 / 月", null, FREE.builds, "int", "每次 push 触发一次构建"),
        quotaItem("站点文件数", null, FREE.files, "int", "当前仓库里的页面与资源总数"),
        quotaItem("单个文件上限", null, FREE.fileSize, "bytes", "超过 25 MiB 构建会直接失败"),
        quotaItem("自定义域名", null, FREE.domains, "int", "每个项目可绑定的域名数"),
      ],
    },
  ];
}

/* D1 自己报的占用大小:page_count × page_size。
   不需要任何 Token,拿不到就返回 null,交给官方接口兜底 */
async function d1SelfSize(db) {
  try {
    const c = await db.prepare("PRAGMA page_count").first();
    const s = await db.prepare("PRAGMA page_size").first();
    const count = Number(c ? Object.values(c)[0] : 0) || 0;
    const size = Number(s ? Object.values(s)[0] : 0) || 0;
    return count && size ? count * size : null;
  } catch (e) {
    return null;
  }
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
