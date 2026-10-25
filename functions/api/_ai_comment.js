/* ============================================================
   103 · 被 @ 之后替 AI 助手回一条
   posts.js 写完评论后调这里:评论里出现「@AI助手 / @AI」就生成一条回复,
   挂在同一条帖子 / 照片 / 视频下面,作者是那个不能登录的「AI 助手」账号。

   三种场景:
   - 照片评论 → 看图说话(缩略图直接喂给视觉模型)
   - 视频评论 → 看封面 + 标题 + 简介
   - 普通帖子 → 按上下文回答问题

   AI 没接上、超时、模型报错,一律静默返回:不能因为 AI 挂了让人发不出评论。
   ============================================================ */

import { aiRun, aiText, aiReady } from "./_ai.js";
import { aiBotId, notify } from "./_utils.js";
import { b2Config, isB2Key, b2ObjectName, s3Get } from "./_b2.js";

/* 视觉用 gemma-4(多模态,直接用 OpenAI 兼容的 image_url 传图,中文描述最自然);
   文本用 qwen3.8-27b。moondream 只听得懂英文提问,中文会复读问题,所以不用它。
   注意:2026 这批模型默认爱「先思考再说话」,一定要压 reasoning_effort,不然 token 全花在自言自语上 */
const VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const TEXT_MODELS = ["@cf/qwen/qwen3.8-27b", "@cf/google/gemma-4-26b-a4b-it"];
const MAX_IMAGE_BYTES = 900 * 1024;

/* 图片字节转 data URI:模型直接吃 base64,私有图片也就不用开公网地址了 */
function dataUri(u8) {
  let mime = "image/jpeg";
  if (u8.length > 12) {
    if (u8[0] === 0x89 && u8[1] === 0x50) mime = "image/png";
    else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57) mime = "image/webp";
    else if (u8[0] === 0x47 && u8[1] === 0x49) mime = "image/gif";
  }
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return "data:" + mime + ";base64," + btoa(bin);
}

const AI_NAME = "AI 助手";

/* 评论里有没有叫 AI */
export function wantsAi(body) {
  const text = String(body || "");
  return /@\s*AI\s*助手/i.test(text) || /@\s*AI(?![A-Za-z0-9_\u4e00-\u9fa5])/i.test(text);
}

/* 从 KV 取图片字节:图库的缩略图在 gal:,头像 / 视频封面在 img: */
async function kvImage(env, key, prefix) {
  if (!key || !env.STORY_KV) return null;
  try {
    const buf = await env.STORY_KV.get(prefix + key, "arrayBuffer");
    if (!buf || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return new Uint8Array(buf);
  } catch (e) {
    return null;
  }
}

/* B2 上的原图按 key 取一份;太大就不给模型,省得请求体爆掉 */
async function b2Image(env, key) {
  if (!key || !isB2Key(key)) return null;
  try {
    const b2 = await b2Config(env, env.DB);
    if (!b2.ready) return null;
    const got = await s3Get(b2, b2ObjectName(key), "");
    if (!got.ok && got.status !== 206) return null;
    const buf = await got.arrayBuffer();
    if (!buf || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return new Uint8Array(buf);
  } catch (e) {
    return null;
  }
}

/* 图库里那张图的缩略图:优先 KV,再试 B2 原图 */
async function galleryImage(env, row) {
  const thumb = await kvImage(env, row.thumb_key, "gal:");
  if (thumb) return thumb;
  return b2Image(env, row.full_key);
}

/* 视频封面(kv 的 img: 前缀) */
async function videoCover(env, coverKey) {
  return kvImage(env, coverKey, "img:");
}

/* 调一次模型:成功回 { text, model },失败回 { text:"", model, error }
   把错误带给自检接口,排障时不用猜 */
async function ask(env, model, payload, timeout) {
  try {
    const out = await aiRun(env, model, payload, timeout);
    return { text: aiText(out).trim(), model };
  } catch (e) {
    return { text: "", model, error: String((e && e.message) || e).slice(0, 180) };
  }
}

/* 把模型输出收成一句能直接发出去的话:去掉引号、去掉「AI:」前缀、限长 */
function polish(raw) {
  let text = String(raw || "")
    .replace(/^\s*(?:AI\s*助手|回复|答)\s*[:：]\s*/i, "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 140) {
    // 太长就截在最后一个句号,别截成语病
    const cut = text.slice(0, 140);
    const dot = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
    text = dot > 40 ? cut.slice(0, dot + 1) : cut;
  }
  return text;
}

const SYSTEM = `你是金华一中 103 班（音乐领军班）班级站点里的 AI 助手。
说话像班里那个嘴有点贫、但心很软的同学：口语化，带一点俏皮和自嘲，偶尔抖个小机灵；但不阴阳怪气、不油腻、不硬凑梗。
只输出你要发在评论区的那段话本身：两三句、不超过 100 字，不要自称 AI，不要加引号，不要解释。`;

/* 主体:生成并写入一条 AI 回复
   opts = { postId(触发的那条评论 id), rootId(挂到哪个根下面), body(评论内容),
            authorId(评论作者), galleryId, videoId } */
export async function replyAsAi(env, opts) {
  // debug=true 时不写库的返回值不叫 0,而是一份「死在哪一步」的报告,自检接口用
  const dbg = !!(opts && opts.debug);
  const t0 = Date.now();
  const stop = (stage, extra) =>
    dbg ? Object.assign({ ok: false, stage, ms: Date.now() - t0 }, extra || {}) : 0;

  if (!env || !env.DB) return stop("no-db");
  if (!(await aiReady(env))) return stop("ai-not-ready");

  const { postId, rootId, body, authorId, galleryId, videoId } = opts;

  let prompt = "";
  let image = null;

  /* 把「之前聊了什么」捞出来:AI 被 @ 时不能只看见最后半句,
     不然像「@AI助手 什么意思」这种它根本不知道在问什么 */
  const clean = (s) => String(s || "").replace(/\s+/g, " ").slice(0, 120);
  async function prevLines(where, value) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT name, body FROM posts WHERE ${where} AND id <> ? ORDER BY created_at DESC LIMIT 6`
      )
        .bind(value, postId || 0)
        .all();
      return (results || []).reverse().map((r) => `${r.name || "某人"}：${clean(r.body)}`);
    } catch (e) {
      return [];
    }
  }
  // 被回复的那条(主帖 / 根评论):它在不在,直接决定 AI 有没有前因
  let rootLine = "";
  if (rootId && rootId !== postId) {
    const root = await env.DB.prepare("SELECT name, body FROM posts WHERE id = ?")
      .bind(rootId)
      .first()
      .catch(() => null);
    if (root && root.body) rootLine = `${root.name || "某人"}：「${clean(root.body)}」`;
  }

  if (galleryId) {
    const row = await env.DB.prepare(
      "SELECT title, full_key, thumb_key, uploaded_by FROM gallery WHERE id = ?"
    )
      .bind(galleryId)
      .first()
      .catch(() => null);
    if (!row) return stop("gallery-missing", { galleryId });
    image = await galleryImage(env, row);
    const caption = String(row.title || "").trim();
    const prev = await prevLines("gallery_id = ?", galleryId);
    const talk = [rootLine ? `被回复的那条：${rootLine}` : "", ...prev.map((x) => `之前评论 ${x}`)]
      .filter(Boolean)
      .join("\n");
    prompt = `场景：班级相册的一张照片${caption ? `，标题叫《${caption}》` : ""}。
${talk ? `照片下面的对话：\n${talk}\n` : ""}同学刚说：「${String(body).slice(0, 400)}」
${
  image
    ? "请看着这张照片，结合上面的对话用两三句话回应：可以评价画面里有什么、氛围怎么样、抓拍得如何，也可以顺着对方的话聊。"
    : "请结合标题和上面的对话，用两三句话回应这张照片给人的感觉。"
}`;
  } else if (videoId) {
    const row = await env.DB.prepare(
      "SELECT title, body, cover_key FROM videos WHERE id = ?"
    )
      .bind(videoId)
      .first()
      .catch(() => null);
    if (!row) return stop("video-missing", { videoId });
    image = await videoCover(env, row.cover_key);
    const title = String(row.title || "").trim();
    const intro = String(row.body || "").replace(/\s+/g, " ").slice(0, 300);
    const prev = await prevLines("video_id = ?", videoId);
    const talk = [rootLine ? `被回复的那条：${rootLine}` : "", ...prev.map((x) => `之前评论 ${x}`)]
      .filter(Boolean)
      .join("\n");
    prompt = `场景：班级视频《${title || "未命名"}》${intro ? `，简介是：${intro}` : ""}。
${talk ? `视频下面的对话：\n${talk}\n` : ""}同学刚评论：「${String(body).slice(0, 400)}」
请结合上面的对话，用两三句话回应：可以聊内容看点、拍得怎么样，语气像同学聊天。${
      image ? "可以配合封面画面来说。" : ""
    }`;
  } else {
    // 主留言板:把主帖 + 之前的回复一起给模型,它才知道在说什么
    const prev = rootId ? await prevLines("parent_id = ?", rootId) : [];
    const talk = [rootLine ? `主帖：${rootLine}` : "", ...prev.map((x) => `之前回复 ${x}`)]
      .filter(Boolean)
      .join("\n");
    prompt = `场景：班级留言板。
${talk ? `${talk}\n` : ""}现在有人说：「${String(body).slice(0, 600)}」
请结合上面的上下文，用两三句话回应：如果是在问问题就直接回答，如果是在分享就接一句有内容的回应。不要装傻说「你没给我上下文」。`;
  }

  // 有图先走视觉模型,没图或失败再退回纯文本模型
  const tried = [];
  let answer = "";
  let usedModel = "";
  if (image) {
    // gemma 走 OpenAI 兼容格式:系统提示 + 文本 + image_url 三件套
    const vr = await ask(
      env,
      VISION_MODEL,
      {
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUri(image) } },
            ],
          },
        ],
        max_tokens: 1400,
        temperature: 0.7,
        reasoning_effort: "low",
      },
      25000
    );
    if (vr.text) {
      answer = polish(vr.text);
      usedModel = vr.model;
    } else {
      tried.push({ model: vr.model, error: vr.error || "没吐文本" });
    }
  }
  if (!answer) {
    for (const model of TEXT_MODELS) {
      const r = await ask(
        env,
        model,
        {
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          // 留足额度:思考链会先吃掉一部分,截太短就会「content 为空、finish_reason=length」
          max_tokens: 700,
          temperature: 0.9,
          reasoning_effort: "low",
        },
        20000
      );
      if (r.text) {
        answer = polish(r.text);
        usedModel = r.model;
        break;
      }
      tried.push({ model: r.model, error: r.error || "没吐文本" });
    }
  }
  if (!answer) {
    return stop("generate-empty", { tried, hasImage: !!image, imageBytes: image ? image.length : 0 });
  }

  const botId = await aiBotId(env.DB);
  if (!botId) return stop("no-ai-account");

  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO posts (name, body, images, salt, pass_hash, cid, parent_id, user_id, region, reply_to_id, pinned, wall_id, video_id, gallery_id, visibility, created_at)
     VALUES (?, ?, '[]', NULL, NULL, NULL, ?, ?, '', ?, 0, NULL, ?, ?, 'public', ?)`
  )
    .bind(AI_NAME, answer, rootId || null, botId, postId || null, videoId || null, galleryId || null, now)
    .run()
    .catch((e) => ({ __err: String((e && e.message) || e).slice(0, 200) }));
  if (!res || !res.success) {
    return stop("insert-failed", { tried, error: (res && res.__err) || "insert 返回失败" });
  }

  // 通知被回的那个人;AI 自己不看通知,不用给别人发
  if (authorId) {
    await notify(env.DB, {
      userId: authorId,
      actorId: botId,
      type: "reply",
      postId: rootId || postId || 0,
      replyId: res.meta.last_row_id,
      galleryId: galleryId || 0,
      videoId: videoId || 0,
      excerpt: answer.slice(0, 80),
    });
  }

  const newId = Number(res.meta.last_row_id) || 0;
  return dbg
    ? {
        ok: true,
        id: newId,
        model: usedModel,
        answer,
        ms: Date.now() - t0,
        tried,
        hasImage: !!image,
      }
    : newId;
}
