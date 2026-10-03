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
    })().catch((err) => {
      schemaReady = null; // 失败就下次重来,不要把错误缓存住
      throw err;
    });
  }
  return schemaReady;
}
