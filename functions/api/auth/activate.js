/* ============================================================
   一次性服主激活
   POST /api/auth/activate  { code }
   必须先登录。口令正确 + 还没被人用过 → 当前账号变成服主。
   用掉之后 settings 里留下 owner_claimed 这一行,此后谁再用都是一句
   「已经用过了」,不可重置、不可转让。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isActivationCode,
  claimOnce,
  CLAIM_KEY,
} from "../_utils.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录，再输入激活口令", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const code = String(payload.code || "");
  if (!code.trim()) return fail("把激活口令填上");

  if (me.role === "owner") return fail("你已经是服主了", 409);

  if (!(await isActivationCode(code))) return fail("口令不对，再核对一下", 403);

  // 原子占位:插得进去说明是我抢到的,插不进去说明早有人用过了
  const claimed = await claimOnce(env.DB, CLAIM_KEY, me.id);
  if (!claimed) return fail("这串口令已经用过了，没有第二次", 409);

  await env.DB.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(me.id).run();

  return json({ ok: true, user: { ...me, role: "owner" } });
}
