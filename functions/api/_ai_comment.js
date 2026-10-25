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

/* 视觉模型只认常见图片格式;缩略图一般几十 KB,超过 900KB 就不再塞了 */
const VISION_MODEL = "@cf/llama-3.2-11b-vision-instruct";
const TEXT_MODELS = ["@cf/meta/llama-3.1-8b-instruct", "@cf/qwen/qwen1.5-14b-chat-awq"];
const MAX_IMAGE_BYTES = 900 * 1024;

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

/* 调一次模型,统一拿文本;模型挂了返回空串 */
async function ask(env, model, payload, timeout) {
  try {
    const out = await aiRun(env, model, payload, timeout);
    return aiText(out).trim();
  } catch (e) {
    return "";
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
说话像这个班的同学：口语化、温和、有分寸，不客套、不夸张，不用「首先/其次」这种书面结构。
只输出你要发在评论区的那段话本身：两三句、不超过 100 字，不要自称 AI，不要加引号，不要解释。`;

/* 主体:生成并写入一条 AI 回复
   opts = { postId(触发的那条评论 id), rootId(挂到哪个根下面), body(评论内容),
            authorId(评论作者), galleryId, videoId } */
export async function replyAsAi(env, opts) {
  if (!env || !env.DB) return 0;
  if (!(await aiReady(env))) return 0;

  const { postId, rootId, body, authorId, galleryId, videoId } = opts;

  let prompt = "";
  let image = null;

  if (galleryId) {
    const row = await env.DB.prepare(
      "SELECT title, full_key, thumb_key, uploaded_by FROM gallery WHERE id = ?"
    )
      .bind(galleryId)
      .first()
      .catch(() => null);
    if (!row) return 0;
    image = await galleryImage(env, row);
    const caption = String(row.title || "").trim();
    prompt = `场景：班级相册的一张照片${caption ? `，标题叫《${caption}》` : ""}。
同学在照片下面说：「${String(body).slice(0, 400)}」
${
  image
    ? "请看着这张照片，用两三句话评价它：画面里有什么、氛围怎么样、抓拍得如何，说具体一点。"
    : "请结合标题和这句话，用两三句话聊聊这张照片给人的感觉。"
}`;
  } else if (videoId) {
    const row = await env.DB.prepare(
      "SELECT title, body, cover_key FROM videos WHERE id = ?"
    )
      .bind(videoId)
      .first()
      .catch(() => null);
    if (!row) return 0;
    image = await videoCover(env, row.cover_key);
    const title = String(row.title || "").trim();
    const intro = String(row.body || "").replace(/\s+/g, " ").slice(0, 300);
    prompt = `场景：班级视频《${title || "未命名"}》${intro ? `，简介是：${intro}` : ""}。
同学在下面评论：「${String(body).slice(0, 400)}」
请用两三句话评价这支片子：内容和看点、拍得怎么样，语气像同学聊天。${
      image ? "可以配合封面画面来说。" : ""
    }`;
  } else {
    // 主留言板:把触发的那条当作问题来答
    prompt = `场景：班级留言板。有人写了：「${String(body).slice(0, 600)}」
请用两三句话回应这段话：如果是在问问题就直接回答，如果是在分享就接一句有内容的回应。`;
  }

  // 有图先走视觉模型,没图或失败再退回纯文本模型
  let answer = "";
  if (image) {
    answer = polish(
      await ask(
        env,
        VISION_MODEL,
        {
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: prompt,
              image: Array.from(image),
            },
          ],
          max_tokens: 260,
        },
        20000
      )
    );
  }
  if (!answer) {
    for (const model of TEXT_MODELS) {
      answer = polish(
        await ask(
          env,
          model,
          {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: prompt },
            ],
            max_tokens: 220,
          },
          15000
        )
      );
      if (answer) break;
    }
  }
  if (!answer) return 0;

  const botId = await aiBotId(env.DB);
  if (!botId) return 0;

  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO posts (name, body, images, salt, pass_hash, cid, parent_id, user_id, region, reply_to_id, pinned, wall_id, video_id, gallery_id, visibility, created_at)
     VALUES (?, ?, '[]', NULL, NULL, NULL, ?, ?, '', ?, 0, NULL, ?, ?, 'public', ?)`
  )
    .bind(AI_NAME, answer, rootId || null, botId, postId || null, videoId || null, galleryId || null, now)
    .run()
    .catch(() => null);
  if (!res || !res.success) return 0;

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

  return Number(res.meta.last_row_id) || 0;
}
