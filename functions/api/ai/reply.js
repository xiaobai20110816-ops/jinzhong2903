/* ============================================================
   103 · AI 帮我想回复
   POST /api/ai/reply   { text: "对方说的话", kind: "comment" | "dm" | "group" }
   返回 { ok, suggestions: ["…", "…", "…"] }

   只给「候选回复」,不替用户发出去 —— 最终的按钮还是人来点。
   AI 没接上就回一句人话,前端据此把按钮置灰 / 提示。
   ============================================================ */

import { json, fail, ensureSchema, currentUser, classGate } from "../_utils.js";
import { aiRun, aiText, aiReady } from "../_ai.js";

/* 先试轻量中文表现还行的模型,不行再换一个。
   Workers AI 的模型名录会变,两个都挂就说明真的没接上 */
const CHAT_MODELS = ["@cf/meta/llama-3.1-8b-instruct", "@cf/qwen/qwen1.5-14b-chat-awq"];

const KIND_LABEL = { dm: "私信", group: "群聊", comment: "照片评论" };

const SYSTEM = `你是金华一中 103 班（音乐领军班）的聊天助手。
任务：根据对方说的话，帮同学想 3 条得体的中文回复。
要求：每条不超过 30 个字，口语化、自然、像高中生在班里聊天；角度各不相同；
不要用颜文字轰炸，不要提 AI，不要输出解释，只输出 3 行回复，每行以「1.」「2.」「3.」开头。`;

/* 模型吐出来的文本 → 干净的 3 条候选。
   模型偶尔会带上「回复：」「以下是」之类的前缀,这里逐行洗一遍 */
function parseSuggestions(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, "").trim())
    .map((line) => line.replace(/^(?:回复|候选|建议)\s*[:：]\s*/, "").trim())
    .filter((line) => line && line.length <= 80)
    .slice(0, 3);
}

export async function onRequestPost({ request, env, params }) {
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  if (!(await aiReady(env))) {
    return fail("AI 助手还没接上，等管理员在 Cloudflare 绑好 Workers AI 就能用了", 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("内容读不出来，刷新一下重试");
  }

  const text = String((payload && payload.text) || "").trim().slice(0, 800);
  const kind = KIND_LABEL[payload && payload.kind] ? payload.kind : "comment";
  if (!text) return fail("先说一句话，AI 才有得参考");

  const prompt = `场景：${KIND_LABEL[kind]}。对方说：「${text}」。请给 3 条候选回复。`;

  for (const model of CHAT_MODELS) {
    try {
      const out = await aiRun(
        env,
        model,
        {
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          max_tokens: 220,
        },
        9000
      );
      const list = parseSuggestions(aiText(out));
      if (list.length) return json({ ok: true, suggestions: list, model });
    } catch (e) {
      /* 换下一个模型 */
    }
  }

  return fail("AI 这次没想出合适的回复，再点一次试试", 502);
}
