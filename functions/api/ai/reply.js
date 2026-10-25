/* ============================================================
   103 · AI 帮我想回复
   POST /api/ai/reply   { text: "对方说的话", kind: "comment" | "dm" | "group" }
   返回 { ok, suggestions: ["…", "…", "…"] }

   只给「候选回复」,不替用户发出去 —— 最终的按钮还是人来点。
   AI 没接上就回一句人话,前端据此把按钮置灰 / 提示。
   ============================================================ */

import { json, fail, ensureSchema, currentUser, classGate } from "../_utils.js";
import { aiRun, aiText, aiReady } from "../_ai.js";

/* 先试便宜、快的 gemma-4,不行再换 qwen3.8。
   Workers AI 的模型名录会变,2026-05 那批 llama-3.1 / qwen1.5 已经下线,别再用老名字 */
const CHAT_MODELS = ["@cf/google/gemma-4-26b-a4b-it", "@cf/qwen/qwen3.8-27b"];

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

/* 把模型返回的形状抠一小段出来,方便排查(只有服主能看到) */
function safeRaw(res) {
  try {
    if (res && typeof res.getReader === "function") return "[stream]";
    const s = JSON.stringify(res);
    return s ? s.slice(0, 600) : String(res);
  } catch (e) {
    return "[读不出来]";
  }
}

/* GET /api/ai/reply   只回答一句「AI 接上了没」。
   绑定和 REST 两条路哪条通、还是都没接上,一看就知道,方便排查。
   加 ?test=1(需服主登录)会真跑一次最小请求,把模型的真实回话 / 报错带回来 */
export async function onRequestGet({ request, env }) {
  let ready = false;
  try {
    ready = await aiReady(env);
  } catch (e) {
    ready = false;
  }
  const via =
    env && env.AI && typeof env.AI.run === "function"
      ? "binding"
      : ready
      ? "token"
      : "";
  const out = { ok: true, ready, via };

  const test = new URL(request.url).searchParams.get("test");
  if (test) {
    const me = await currentUser(request, env).catch(() => null);
    if (!me || me.role !== "owner") return fail("测试要服主登录后再点", 403);
    try {
      const res = await aiRun(
        env,
        CHAT_MODELS[0],
        {
          messages: [
            { role: "system", content: "只回两个字：通了" },
            { role: "user", content: "回我两个字" },
          ],
          max_tokens: 60,
        },
        15000
      );
      let text = aiText(res).trim();
      // 有的模型会直接回一个流,读一遍再判断
      if (!text && res && typeof res.getReader === "function") {
        const rd = res.getReader();
        const dec = new TextDecoder();
        let acc = "";
        for (;;) {
          const step = await rd.read();
          if (step.done) break;
          acc += dec.decode(step.value, { stream: true });
        }
        text = acc.trim();
        if (!text) text = "";
      }
      out.test = text
        ? { ok: true, text: text.slice(0, 60) }
        : { ok: false, error: "模型没吐文本", raw: safeRaw(res) };
    } catch (e) {
      out.test = { ok: false, error: String((e && e.message) || e).slice(0, 140) };
    }
  }

  return json(out);
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
