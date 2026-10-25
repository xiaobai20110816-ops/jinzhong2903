/* ============================================================
   103 · Workers AI 小工具
   Cloudflare 的 AI 有两种叫法方式,这里统一成一条路:
   1) 项目里绑了 Workers AI(变量名 AI) —— 直接用 env.AI.run,最快;
   2) 没绑 —— 退回 REST,用后台「用量看板」里存的 cf_api_token 调。
   两条路都不通就抛错,调用方自己决定是「跳过 AI」还是「提示没接上」。
   ============================================================ */

import { getSetting } from "./_utils.js";

const CF_ACCOUNT_FALLBACK = "2bb27ee5aa6faadbcc0cb6fefa21351f";

/* 调一次模型,返回模型吐出来的原始结果(绑定是对象,REST 是 {result})。
   timeout 到点就中止:少一次 AI 不影响用户发消息,但不能让人干等 */
export async function aiRun(env, model, payload, timeout = 6000) {
  if (env && env.AI && typeof env.AI.run === "function") {
    return await env.AI.run(model, payload);
  }

  if (!env || !env.DB) throw new Error("AI 还没接上");
  const token = await getSetting(env.DB, "cf_api_token");
  if (!token) throw new Error("AI 还没接上");
  const account = (await getSetting(env.DB, "cf_account_id")) || CF_ACCOUNT_FALLBACK;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false) {
      throw new Error("AI 调用失败(" + res.status + ")");
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

/* 绑定和 REST 两种返回形状不一样,视觉模型又是另一套字段,这里统一成一段文本 */
export function aiText(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  if (typeof out.response === "string") return out.response;
  if (typeof out.result === "string") return out.result;
  // moondream 这类图生文模型:query 回 answer,caption 回 caption
  if (typeof out.answer === "string") return out.answer;
  if (typeof out.caption === "string") return out.caption;
  if (typeof out.description === "string") return out.description;
  if (out.result && typeof out.result === "object") return aiText(out.result);
  // 万一走的是 OpenAI 兼容格式
  const choice = Array.isArray(out.choices) ? out.choices[0] : null;
  if (choice && choice.message && typeof choice.message.content === "string") {
    return choice.message.content;
  }
  return "";
}

/* AI 到底能不能用:给前端一句人话,不用每次真调一遍模型 */
export async function aiReady(env) {
  if (env && env.AI && typeof env.AI.run === "function") return true;
  if (!env || !env.DB) return false;
  return !!(await getSetting(env.DB, "cf_api_token"));
}
