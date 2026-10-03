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

      // 老库升级:parent_id 是后加的。CREATE TABLE IF NOT EXISTS 对已存在的表
      // 不会补列,SQLite 又没有 ADD COLUMN IF NOT EXISTS,所以先探一下这列在不在。
      const hasParent = await db
        .prepare("SELECT parent_id FROM posts LIMIT 1")
        .first()
        .then(() => true)
        .catch(() => false);
      if (!hasParent) {
        try {
          await db.prepare("ALTER TABLE posts ADD COLUMN parent_id INTEGER").run();
        } catch (e) {
          /* 并发的另一个请求可能刚加过,忽略 */
        }
      }
      await db
        .prepare(`CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at)`)
        .run();
    })().catch((err) => {
      schemaReady = null; // 失败就下次重来,不要把错误缓存住
      throw err;
    });
  }
  return schemaReady;
}

/* 把一页根帖下面整棵回复树一次捞齐(广度优先,避免逐条查库)。
   返回扁平数组,顺序是「根帖先、同层按时间早晚」 */
export async function loadThread(db, rootIds) {
  const all = [];
  let frontier = rootIds.filter((id) => id);
  while (frontier.length) {
    const holes = frontier.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT id, name, body, images, parent_id, created_at
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

/* 一行数据库记录 → 前端要的样子 */
export function toPost(row) {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    images: safeParse(row.images).filter((k) => IMAGE_KEY_RE.test(k)),
    created_at: row.created_at,
  };
}
