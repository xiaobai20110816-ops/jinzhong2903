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

/* 建表:第一次请求时自动建好,同一个 isolate 内只跑一次。
   这样用户就不用去控制台手写 SQL 了 */
let schemaReady = null;

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
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at)`)
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

/* 一行 users 记录 → 前端能用的样子(绝不外泄 salt / pass_hash) */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.username,
    role: row.role || "member",
    avatar: row.avatar_key || "",
    signature: row.signature || "",
  };
}

/* 从 Cookie 里认出当前登录的人;没登录或已过期就返回 null。
   顺便把过期的会话删掉,免得 sessions 表越攒越大 */
export async function currentUser(request, env) {
  if (!env.DB) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.avatar_key, u.signature, s.expires_at
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
   服主账号:口令由环境变量决定,站点第一次被访问时自动建好
   优先 OWNER_PASSWORD;没设就沿用老的 ADMIN_PASSWORD(班委总口令)。
   两个都没设就跳过——站点照常能用,只是暂时没有服主。
   ============================================================ */

const OWNER_NAME = "小柏";
let ownerReady = null;

async function doEnsureOwner(db, env) {
  const password = String(env.OWNER_PASSWORD || env.ADMIN_PASSWORD || "");
  if (!password) return;

  const row = await db
    .prepare("SELECT id, salt, pass_hash, role FROM users WHERE username = ?")
    .bind(OWNER_NAME)
    .first();

  if (!row) {
    const salt = randomHex(8);
    await db
      .prepare(
        `INSERT OR IGNORE INTO users
           (username, salt, pass_hash, avatar_key, signature, role, cid, created_at)
         VALUES (?, ?, ?, NULL, ?, 'owner', NULL, ?)`
      )
      .bind(
        OWNER_NAME,
        salt,
        await hashPassword(password, salt),
        "这里是 103 的官方发布台。",
        Date.now()
      )
      .run();
    return;
  }

  // 口令换过了就同步一次,免得环境变量和库里对不上
  if (row.pass_hash !== (await hashPassword(password, row.salt))) {
    await db
      .prepare("UPDATE users SET pass_hash = ?, role = 'owner' WHERE id = ?")
      .bind(await hashPassword(password, row.salt), row.id)
      .run();
  } else if (row.role !== "owner") {
    await db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(row.id).run();
  }
}

export function ensureOwner(db, env) {
  if (ownerReady) return ownerReady;
  ownerReady = doEnsureOwner(db, env).catch((err) => {
    ownerReady = null; // 失败下次重来
    throw err;
  });
  return ownerReady;
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
  "id, name, body, images, parent_id, user_id, region, reply_to_id, pinned, created_at";

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
    created_at: row.created_at,
  };
}
