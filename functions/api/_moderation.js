/* ============================================================
   103 · 内容审核
   发帖 / 评论 / 私信 / 群聊在写库之前都过一遍这里。
   两层:
   1) 规则层(永远生效):长度、刷屏、外部链接、明显的脏话 / 广告词;
   2) AI 层(接上了才生效):让通用模型判 SAFE / UNSAFE。
   AI 调不通就只走规则 —— 宁可少拦一句,也不能让同学发不出消息。
   ============================================================ */

import { aiRun, aiText, aiReady } from "./_ai.js";

/* 只放「一眼就不该出现在班级页面上」的词,不做泛化匹配。
   真遇到规则漏掉的,由管理员在后台删掉即可 */
const BAD_WORDS = [
  "傻逼", "煞笔", "沙比", "草泥马", "去死", "弄死你", "死全家",
  "约炮", "裸聊", "一夜情", "开房陪", "卖淫", "嫖娼",
  "赌博", "博彩", "网赌", "时时彩", "六合彩",
  "刷单", "日结兼职", "高薪兼职", "代开发票", "办证",
  "代考", "代写作业", "枪手代", "包过",
  "加微信领", "加qq领", "扫码领钱", "返利群",
];

/* 明显的站外导流:班级页面不需要贴外链,真要分享让管理员发 */
const LINK_RE = /(https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,})/i;

export const MAX_MOD_TEXT = 4000;

/* 纯规则,不碰网络。返回 { ok } 或 { ok:false, reason } */
export function ruleCheck(raw) {
  const text = String(raw == null ? "" : raw);
  if (text.length > MAX_MOD_TEXT) return { ok: false, reason: "内容太长了，精简一下吧" };
  if (LINK_RE.test(text)) return { ok: false, reason: "站内先别贴外部链接，容易被当成广告" };
  // 同一个字连着刷十几个:凑字数、刷屏都长这样
  if (/(.)\1{14,}/.test(text)) return { ok: false, reason: "重复的字太多了，正常说一句吧" };
  // 一大串没有空格的乱码 / 复制粘贴的推广语
  if (/[A-Za-z0-9]{40,}/.test(text)) return { ok: false, reason: "这串字符看着像广告，换个说法吧" };
  for (const w of BAD_WORDS) {
    if (text.indexOf(w) >= 0) return { ok: false, reason: "这句话里有不太合适的词，换个说法吧" };
  }
  return { ok: true };
}

/* 规则 + AI。kind 只用来拼提示语(帖子 / 评论 / 私信)。
   短句、纯表情不送 AI,省一次调用也省额度 */
export async function moderate(env, raw, kind = "内容") {
  const text = String(raw == null ? "" : raw).trim();
  const byRule = ruleCheck(text);
  if (!byRule.ok) return byRule;
  if (text.length < 6) return { ok: true };
  if (!(await aiReady(env))) return { ok: true };

  try {
    /* llama-guard 系列 2026-05 已下线,改成让通用模型按 SAFE / UNSAFE 二选一回答,
       只认第一个词,免得它多写两句被误判 */
    const out = await aiRun(
      env,
      "@cf/google/gemma-4-26b-a4b-it",
      {
        messages: [
          {
            role: "system",
            content:
              "你是班级社区的内容审核员。只判断有没有明显的辱骂、色情、暴力、违法或广告内容。只回一个词：SAFE 或 UNSAFE。",
          },
          { role: "user", content: text.slice(0, 2000) },
        ],
        max_tokens: 8,
        temperature: 0,
      },
      5000
    );
    const verdict = aiText(out).trim().toLowerCase();
    if (/^unsafe/.test(verdict)) {
      return { ok: false, reason: `这段${kind}没通过 AI 审核，换个说法再发吧` };
    }
  } catch (e) {
    /* AI 没接上 / 超时 / 报错:退回「只看规则」,别把正常发言卡住 */
  }
  return { ok: true };
}
