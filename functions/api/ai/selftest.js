/* 临时自检接口:跑一遍完整的「@AI 助手 → 生成 → 落库 → 读回 → 删除」流程。
   只给服主排查用,填好 key 后访问:
   /api/ai/selftest?k=st-7f3a91c4e2&kind=text|photo|video
   排查完立刻删除本文件。 */

import { json, ensureSchema } from "../_utils.js";
import { replyAsAi } from "../_ai_comment.js";
import { aiRun, aiText } from "../_ai.js";

const KEY = "st-7f3a91c4e2";

/* 图片字节 → base64(和 _ai_comment.js 里同一套做法) */
function b64(u8) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(bin);
}

function safeRaw(res) {
  try {
    if (res && typeof res.getReader === "function") return "[stream]";
    const s = JSON.stringify(res);
    return s ? s.slice(0, 500) : String(res);
  } catch (e) {
    return "[读不出来]";
  }
}

/* 视觉模型换几种传参方式试一遍,看它到底吃什么、吐什么 */
async function visionProbe(env, kind) {
  const out = { ok: true, kind: "vision", variants: [] };

  let key = "";
  let prefix = "gal:";
  if (kind === "video") {
    const v = await env.DB.prepare("SELECT cover_key FROM videos ORDER BY id DESC LIMIT 1").first();
    key = v && v.cover_key;
    prefix = "img:";
  } else {
    const g = await env.DB.prepare("SELECT thumb_key FROM gallery ORDER BY id DESC LIMIT 1").first();
    key = g && g.thumb_key;
  }
  if (!key || !env.STORY_KV) {
    out.error = "no-image-key";
    return out;
  }
  const buf = await env.STORY_KV.get(prefix + key, "arrayBuffer");
  if (!buf) {
    out.error = "kv-miss";
    return out;
  }
  const u8 = new Uint8Array(buf);
  out.imageBytes = u8.length;
  const base64 = b64(u8);
  const uri = "data:image/jpeg;base64," + base64;
  const q = "这张照片里有什么？拍得怎么样？用两句话说说。";

  const MOON = "@cf/moondream/moondream3.1-9B-A2B";
  const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
  const en = "Describe what is in this photo and how it was shot. Answer in two sentences.";
  const zh = "用两句话描述这张照片里有什么、拍得怎么样。直接说答案，不要复述问题。";
  const gemmaPayload = (text, maxTokens) => ({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: uri } },
        ],
      },
    ],
    max_tokens: maxTokens,
    reasoning_effort: "low",
  });
  const variants = [
    { name: "F-nostream-zh", model: MOON, payload: { task: "query", image: uri, question: q, reasoning: false, max_tokens: 300, stream: false } },
    { name: "G-en-question", model: MOON, payload: { task: "query", image: uri, question: en, reasoning: false, max_tokens: 300, stream: false } },
    { name: "H-prompt", model: MOON, payload: { task: "query", image: uri, prompt: en, max_tokens: 300, stream: false } },
    { name: "I-gemma-1600", model: GEMMA, payload: gemmaPayload(zh, 1600) },
    { name: "J-gemma-1200", model: GEMMA, payload: gemmaPayload(zh, 1200) },
  ];

  for (const v of variants) {
    const t0 = Date.now();
    try {
      const r = await aiRun(env, v.model, v.payload, 30000);
      const text = aiText(r).trim();
      out.variants.push({
        name: v.name,
        ok: !!text,
        ms: Date.now() - t0,
        text: text.slice(0, 150),
        raw: text ? undefined : safeRaw(r),
      });
    } catch (e) {
      out.variants.push({ name: v.name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 180) });
    }
  }

  return out;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return json({ ok: false, error: "no" }, 404);
  if (!env || !env.DB) return json({ ok: false, error: "no-db" }, 500);

  await ensureSchema(env.DB);

  const kind = url.searchParams.get("kind") || "text";
  const out = { ok: true, kind, aiReady: !!(env.AI && env.AI.run) };

  if (kind === "vision" || kind === "vision-video") {
    return json(await visionProbe(env, kind === "vision-video" ? "video" : "photo"));
  }

  let rootId = 0;
  let galleryId = 0;
  let videoId = 0;

  if (kind === "photo") {
    const row = await env.DB.prepare("SELECT id FROM gallery ORDER BY id DESC LIMIT 1").first();
    if (!row) {
      out.reply = { ok: false, stage: "no-gallery-row" };
      return json(out);
    }
    galleryId = row.id;
  } else if (kind === "video") {
    const row = await env.DB.prepare("SELECT id FROM videos ORDER BY id DESC LIMIT 1").first();
    if (!row) {
      out.reply = { ok: false, stage: "no-video-row" };
      return json(out);
    }
    videoId = row.id;
  } else {
    const row = await env.DB.prepare(
      "SELECT id FROM posts WHERE parent_id IS NULL ORDER BY id DESC LIMIT 1"
    ).first();
    rootId = (row && row.id) || 0;
  }

  // 让 AI 真去看图 / 看视频:用最新一条素材,内容真实
  const body = kind === "photo" ? "@AI助手 这张照片拍得怎么样？" : kind === "video" ? "@AI助手 这个视频怎么样？" : "@AI助手 你觉得呢？";

  const t0 = Date.now();
  out.reply = await replyAsAi(env, {
    postId: rootId,
    rootId: rootId,
    body,
    authorId: 0,
    galleryId,
    videoId,
    debug: true,
  });
  out.totalMs = Date.now() - t0;

  // 读回来看看关键字段写对没有
  if (out.reply && out.reply.ok && out.reply.id) {
    const row = await env.DB.prepare(
      "SELECT id, name, user_id, parent_id, wall_id, video_id, gallery_id, reply_to_id, visibility FROM posts WHERE id = ?"
    )
      .bind(out.reply.id)
      .first()
      .catch(() => null);
    out.row = row;
    // 按各页面真实的查询口径数一遍,验证「写进去了但页面看不到」这种情况
    if (videoId) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE video_id = ?").bind(videoId).first();
      out.visibleInVideoComments = (c && c.n) || 0;
    }
    if (galleryId) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE gallery_id = ?").bind(galleryId).first();
      out.visibleInGalleryComments = (c && c.n) || 0;
    }
    // 测试数据不留在线上
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(out.reply.id).run().catch(() => {});
    out.cleaned = true;
  }

  return json(out);
}
