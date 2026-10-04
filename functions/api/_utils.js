/* ============================================================
   103 纪事 · 后端公共工具
   Cloudflare Pages Functions 里被各个接口复用的一小撮函数。
   文件名以下划线开头,不会被当成路由。
   ============================================================ */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

/* 需要顺手下发 Cookie(登录/注册/退出)时用这个 */
export function jsonWith(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/* 统一的「后端还没接上」提示:控制台绑定还没做完时,前端能读到人话而不是 500 */
export function notReady(what = "后端") {
  return fail(`${what}还没接上，需要先完成 Cloudflare 绑定`, 503);
}

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* 删帖口令绝不存明文:每条帖子一个随机盐,再算 SHA-256 */
export async function hashPassword(password, salt) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(salt + "::" + password)
  );
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeParse(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

/* 图片 key 白名单:只接受我们自己上传时生成的形状,
   防止有人往帖子里塞任意字符串当图片地址 */
export const IMAGE_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

/* 官方认证的三个级别:金 / 红 / 黑,只影响药丸配色。
   空串 = 没级别(头衔也空就是没认证,头衔有值但级别空则按金处理) */
export const CERT_LEVELS = ["gold", "red", "black"];
export function certLevel(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return CERT_LEVELS.includes(v) ? v : "";
}

/* 建表:第一次请求时自动建好,同一个 isolate 内只跑一次。
   这样用户就不用去控制台手写 SQL 了 */
let schemaReady = null;

/* 表结构版本号:以后改了下面的建表 / 补列语句,就把这个号往上抬一位。
   每个新 isolate 里先查这一次轻量标记,对得上就直接返回,
   不用把十几条建表语句再重跑一遍 —— 冷启动时的数据库往返从十几次降到一次 */
const SCHEMA_KEY = "schema_version";
const SCHEMA_VERSION = "2026-10-05.3";

/* SQLite 没有 ADD COLUMN IF NOT EXISTS。先探一下这列在不在,不在才加。
   老库升级 + 并发请求都会走到这里,所以失败要吞掉:多半是别的请求刚加完 */
async function addColumn(db, table, col, type) {
  const has = await db
    .prepare(`SELECT ${col} FROM ${table} LIMIT 1`)
    .first()
    .then(() => true)
    .catch(() => false);
  if (has) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  } catch (e) {
    /* 并发的另一个请求可能刚加过,忽略 */
  }
}

export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // 先问一句「表建好了吗」。settings 表还不存在时这里会抛错,
      // 正好当成「第一次来」处理,继续往下走完整的建表流程
      const mark = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind(SCHEMA_KEY)
        .first()
        .catch(() => null);
      if (mark && mark.value === SCHEMA_VERSION) return;

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS posts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             body TEXT NOT NULL,
             images TEXT NOT NULL DEFAULT '[]',
             salt TEXT,
             pass_hash TEXT,
             cid TEXT,
             parent_id INTEGER,
             created_at INTEGER NOT NULL
           )`
        )
        .run();
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)`)
        .run();
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_cid ON posts(cid, created_at DESC)`)
        .run();

      // 老库升级:这些列都是后加的
      await addColumn(db, "posts", "parent_id", "INTEGER");
      await addColumn(db, "posts", "user_id", "INTEGER");     // 发帖人账号(老匿名帖为 NULL)
      await addColumn(db, "posts", "region", "TEXT");         // IP 属地,只到省份,如「浙江」
      await addColumn(db, "posts", "reply_to_id", "INTEGER"); // B 站式回复:回复的是哪一条
      await addColumn(db, "posts", "pinned", "INTEGER DEFAULT 0");
      await addColumn(db, "posts", "wall_id", "INTEGER");      // 挂在谁的「个人主页留言墙」下(主留言板为 NULL)
      await addColumn(db, "posts", "visibility", "TEXT DEFAULT 'public'"); // 'public' 所有人可见 / 'class' 仅本班(登录)可见
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at)`)
        .run();
      // 这两个是给高频查询用的,没有它们每次都得全表扫:
      // 「某人发过的主帖」(按 user_id) 和「某人主页的留言墙」(按 wall_id)
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at DESC)`)
        .run();
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_wall ON posts(wall_id, created_at DESC)`)
        .run();

      // ---- 账号 ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS users (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             username TEXT NOT NULL UNIQUE,
             salt TEXT NOT NULL,
             pass_hash TEXT NOT NULL,
             avatar_key TEXT,
             signature TEXT,
             role TEXT NOT NULL DEFAULT 'member',
             cid TEXT,
             created_at INTEGER NOT NULL
           )`
        )
        .run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_cid ON users(cid)`).run();

      // 老库升级:封禁标记(1 = 登不进来,但账号和留言都还在)
      await addColumn(db, "users", "banned", "INTEGER DEFAULT 0");
      // 实名:真名由服主 / 管理员在后台录入并审核,
      // verified = 1 才算通过,通过后才出现在「学生风采」里
      await addColumn(db, "users", "real_name", "TEXT");
      await addColumn(db, "users", "verified", "INTEGER DEFAULT 0");
      // 官方认证头衔:只有服主能写,空串 = 没认证;内容公开给所有人看
      await addColumn(db, "users", "cert_title", "TEXT");
      // 官方认证级别:gold / red / black 三档,只决定药丸配色
      await addColumn(db, "users", "cert_level", "TEXT");
      // 个人主页相册:存图片 key 的 JSON 数组(最多 9 张)
      await addColumn(db, "users", "photos", "TEXT");

      // ---- 个人主页点赞:一人对一人只能点一次,靠联合主键去重 ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS profile_likes (
             from_id INTEGER NOT NULL,
             to_id INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (from_id, to_id)
           )`
        )
        .run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_likes_to ON profile_likes(to_id)`).run();

      // ---- 登录会话:token 存库,浏览器只拿 httpOnly Cookie ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS sessions (
             token TEXT PRIMARY KEY,
             user_id INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL
           )`
        )
        .run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`).run();
      // 登录时顺手清过期会话,按 expires_at 找,别扫全表
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)`).run();

      // ---- 用量统计:每天每个页面被看多少次,每天来过多少个人 ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS pageviews (
             day TEXT NOT NULL,
             path TEXT NOT NULL,
             hits INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (day, path)
           )`
        )
        .run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pv_day ON pageviews(day)`).run();
      // 访客去重靠联合主键:同一台设备 / 同一个账号,一天只留一行
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS daily_visitors (
             day TEXT NOT NULL,
             who TEXT NOT NULL,
             PRIMARY KEY (day, who)
           )`
        )
        .run();

      // ---- 站点开关:一行一个开关,靠主键唯一性做「只能成功一次」的事 ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS settings (
             key TEXT PRIMARY KEY,
             value TEXT,
             updated_at INTEGER NOT NULL
           )`
        )
        .run();

      // ---- 互动通知:谁回复了我 / 谁在我主页留了言 / 谁赞了我 ----
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS notifications (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             user_id INTEGER NOT NULL,
             actor_id INTEGER,
             type TEXT NOT NULL,
             post_id INTEGER,
             wall_id INTEGER,
             reply_id INTEGER,
             excerpt TEXT,
             read INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL
           )`
        )
        .run();
      // 老库升级:记下「被回复/被留言的那条自己的 id」,点通知才能直接跳到那一条
      await addColumn(db, "notifications", "reply_id", "INTEGER");
      // 只查「我的、未读的、最新的」,这三列一起建索引最省
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC)`
        )
        .run();

      // 全建好了,记下版本号:下一个 isolate 只查这一行就能直接收工
      await db
        .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(SCHEMA_KEY, SCHEMA_VERSION, Date.now())
        .run();
    })().catch((err) => {
      schemaReady = null; // 失败就下次重来,不要把错误缓存住
      throw err;
    });
  }
  return schemaReady;
}

/* ============================================================
   账号 / 会话
   ============================================================ */

export const COOKIE_NAME = "c103_session";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 登录状态保留 90 天

export const ROLE_OWNER = "owner";
export const ROLE_ADMIN = "admin";

/* 会话 Cookie:httpOnly 让 JS 读不到(防 XSS 偷 token),
   SameSite=Lax 挡掉跨站请求伪造,Secure 只在 https 下发送 */
export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/* 用户名规则:2~16 位,中文 / 字母 / 数字 / 下划线 */
export const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/;

/* 一行 users 记录 → 前端能用的样子(绝不外泄 salt / pass_hash)。
   这个函数只用在「返回给本人」的接口上(登录 / 注册 / 我),
   所以真名一并带上没问题 —— 自己当然看得到自己的真名 */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.username,
    role: row.role || "member",
    avatar: row.avatar_key || "",
    signature: row.signature || "",
    banned: row.banned ? 1 : 0,
    verified: row.verified ? 1 : 0,
    real_name: String(row.real_name == null ? "" : row.real_name).trim(),
    // 官方认证头衔:公开信息,自己当然也看得到
    cert_title: String(row.cert_title == null ? "" : row.cert_title).trim(),
    cert_level: certLevel(row.cert_level),
    // 个人主页相册:自己看自己时一并带上,方便直接渲染
    photos: safeParse(row.photos),
  };
}

/* ============================================================
   实名可见性
   规则:真名只给「服主 / 管理员」和「已实名的同学」看。
   没权限的人(游客、还没实名的账号)看到的一律是账号名。
   ============================================================ */

export function canSeeRealName(viewer) {
  return isStaff(viewer) || !!(viewer && viewer.verified);
}

/* 一行 users → 按「看的人」的权限决定带不带真名。
   服主 / 管理员连没审核的真名也看得到(要拿来审核);
   已实名的同学只看得到同样审核通过的人的真名。 */
export function namedUser(row, viewer) {
  if (!row) return null;
  const out = {
    id: row.id,
    name: row.username,
    role: row.role || "member",
    avatar: row.avatar_key || "",
    verified: row.verified ? 1 : 0,
    // 认证头衔是公开信息,不跟真名一样做权限过滤
    cert_title: String(row.cert_title == null ? "" : row.cert_title).trim(),
    cert_level: certLevel(row.cert_level),
  };
  const rn = String(row.real_name == null ? "" : row.real_name).trim();
  if (rn) {
    if (isStaff(viewer)) out.real_name = rn;
    else if (viewer && viewer.verified && out.verified) out.real_name = rn;
  }
  return out;
}

/* 从 Cookie 里认出当前登录的人;没登录或已过期就返回 null。
   顺便把过期的会话删掉,免得 sessions 表越攒越大 */
export async function currentUser(request, env) {
  if (!env.DB) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.avatar_key, u.signature, u.banned,
            u.real_name, u.verified, u.cert_title, u.cert_level, u.photos, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(token)
    .first()
    .catch(() => null);

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run().catch(() => {});
    return null;
  }
  // 被封禁的账号等于没登录:留着会话也进不来,顺便把这条废会话清掉
  if (row.banned) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run().catch(() => {});
    return null;
  }
  return publicUser(row);
}

export function isStaff(user) {
  return !!user && (user.role === ROLE_OWNER || user.role === ROLE_ADMIN);
}

/* ============================================================
   IP 属地:只解析到省级就停,原始 IP 一个字节都不落库
   ============================================================ */

const CN_REGION = {
  BJ: "北京", TJ: "天津", HE: "河北", SX: "山西", NM: "内蒙古",
  LN: "辽宁", JL: "吉林", HL: "黑龙江", SH: "上海", JS: "江苏",
  ZJ: "浙江", AH: "安徽", FJ: "福建", JX: "江西", SD: "山东",
  HA: "河南", HB: "湖北", HN: "湖南", GD: "广东", GX: "广西",
  HI: "海南", CQ: "重庆", SC: "四川", GZ: "贵州", YN: "云南",
  XZ: "西藏", SN: "陕西", GS: "甘肃", QH: "青海", NX: "宁夏",
  XJ: "新疆", TW: "台湾", HK: "香港", MO: "澳门",
};

const OVERSEAS = {
  US: "美国", JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚",
  TH: "泰国", GB: "英国", FR: "法国", DE: "德国", AU: "澳大利亚",
  CA: "加拿大", RU: "俄罗斯", NZ: "新西兰", IT: "意大利", ES: "西班牙",
};

/* Cloudflare 会在 request.cf 里给出 regionCode(如 ZJ)与 country(如 CN)。
   我们只用它算出「浙江」两个字,原始 IP 不读取、不存储 */
export function regionOf(request) {
  const cf = request.cf || {};
  const code = String(cf.regionCode || "").toUpperCase();
  if (CN_REGION[code]) return CN_REGION[code];
  const country = String(cf.country || "").toUpperCase();
  if (country === "CN") return "中国";
  if (!country) return "";
  return OVERSEAS[country] || "海外";
}

/* ============================================================
   一次性服主激活口令

   口令明文不入仓库:这里只留 SHA-256(固定盐 + 明文)。
   谁先登录后用它,谁就成为服主;之后 settings 里会写死一行
   owner_claimed,再拿这串口令来只会被告知「已经用过了」。
   没有后路:不做转让,也没法重置。
   ============================================================ */

const ACTIVATION_SALT = "103-vanguard-2026";
const ACTIVATION_SHA256 = "ac4aa0ea59eb903c48abf13f4297de331183f787aafe318303ead729debc40a5";
export const CLAIM_KEY = "owner_claimed";

export async function isActivationCode(code) {
  const input = String(code || "").trim().toUpperCase();
  if (!input) return false;
  return (await hashPassword(input, ACTIVATION_SALT)) === ACTIVATION_SHA256;
}

/* 原子占位:settings 的主键决定了只有一个请求能插进去。
   插进去 = 我抢到了;插不进去 = 别人已经用过了 */
export async function claimOnce(db, key, value) {
  const res = await db
    .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, String(value == null ? "" : value), Date.now())
    .run();
  return !!(res.meta && res.meta.changes);
}

/* 把一页根帖下面所有回复一次捞齐(广度优先,避免逐条查库)。
   返回扁平数组,顺序是「根帖先、同层按时间早晚」 */
export async function loadThread(db, rootIds) {
  const all = [];
  let frontier = rootIds.filter((id) => id);
  while (frontier.length) {
    const holes = frontier.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT ${POST_COLS}
           FROM posts
          WHERE parent_id IN (${holes})
          ORDER BY created_at ASC, id ASC`
      )
      .bind(...frontier)
      .all();
    if (!results || !results.length) break;
    all.push(...results);
    frontier = results.map((r) => r.id);
  }
  return all;
}

/* 列表要读的列:集中一处,加字段时不会漏掉某条 SQL */
export const POST_COLS =
  "id, name, body, images, parent_id, user_id, region, reply_to_id, pinned, wall_id, visibility, created_at";

/* 一行数据库记录 → 前端要的样子 */
export function toPost(row) {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    images: safeParse(row.images).filter((k) => IMAGE_KEY_RE.test(k)),
    user_id: row.user_id || 0,
    region: row.region || "",
    reply_to_id: row.reply_to_id || 0,
    pinned: row.pinned ? 1 : 0,
    wall_id: row.wall_id || 0,
    visibility: row.visibility === "class" ? "class" : "public",
    created_at: row.created_at,
  };
}

/* ============================================================
   用量统计
   ============================================================ */

/* 按「北京时间的自然日」归堆。库里存的是毫秒时间戳,
   直接切 UTC 日期会把凌晨 0~8 点的访问算到前一天去 */
export function dayKey(ts = Date.now(), shiftDays = 0) {
  const t = Number(ts) + 8 * 3600 * 1000 + shiftDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/* 记一次页面浏览。挂在 /api/auth/me 上顺带完成,
   所以统计本身不会给页面多添一个网络请求;
   也可以用 waitUntil 丢到后台,不拖慢响应 */
export function recordView(env, request, me, waitUntil) {
  if (!env.DB) return;
  const job = doRecordView(env, request, me).catch(() => {
    /* 统计是附带的事,出任何错都不能影响正常请求 */
  });
  if (waitUntil) waitUntil(job);
}

async function doRecordView(env, request, me) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("p");
  if (!raw) return;

  // 只留路径:去掉查询串、结尾的 .html 和斜杠,页面改名也不会把统计拆散
  let path = String(raw).split("?")[0].split("#")[0].trim().slice(0, 60);
  if (!path) return;
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\.html$/, "");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path) path = "/";

  const day = dayKey();
  const cid = (url.searchParams.get("v") || "").slice(0, 40);

  const jobs = [
    env.DB.prepare(
      `INSERT INTO pageviews (day, path, hits) VALUES (?, ?, 1)
       ON CONFLICT(day, path) DO UPDATE SET hits = hits + 1`
    )
      .bind(day, path)
      .run()
      .catch(() => {}),
  ];

  // 同一个人一天只算一次访客:登录了按账号算,没登录按设备随机 id 算
  const who = me ? "u" + me.id : cid ? "c" + cid : "";
  if (who) {
    jobs.push(
      env.DB.prepare("INSERT OR IGNORE INTO daily_visitors (day, who) VALUES (?, ?)")
        .bind(day, who)
        .run()
        .catch(() => {})
    );
  }

  await Promise.all(jobs);
}

/* settings 表里存一行(用量看板的 Cloudflare Token 就用它) */
export async function putSetting(db, key, value) {
  await db
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, String(value == null ? "" : value), Date.now())
    .run();
}

export async function delSetting(db, key) {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getSetting(db, key) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first()
    .catch(() => null);
  return row ? String(row.value || "") : "";
}

/* ============================================================
   互动通知
   谁回复了我的帖子 / 谁在我主页留言 / 谁赞了我 —— 记一行给「我」。
   自己对自己做的事不记;通知只是锦上添花,失败一律吞掉,绝不影响主流程。
   ============================================================ */

export async function notify(db, opts) {
  const userId = parseInt(opts.userId, 10) || 0;
  const actorId = parseInt(opts.actorId, 10) || 0;
  if (!userId || userId === actorId) return;
  try {
    await db
      .prepare(
        `INSERT INTO notifications (user_id, actor_id, type, post_id, wall_id, reply_id, excerpt, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .bind(
        userId,
        actorId,
        String(opts.type || ""),
        parseInt(opts.postId, 10) || null,
        parseInt(opts.wallId, 10) || null,
        parseInt(opts.replyId, 10) || null,
        String(opts.excerpt || "").slice(0, 120),
        Date.now()
      )
      .run();
  } catch (e) {
    /* 记不上就算了,别让通知拖垮正经业务 */
  }
}
