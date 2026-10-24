/* ============================================================
   103 纪事 · 提交问卷答案
   POST /api/surveys/:id/answer   { answers: [...] }
   登录后一人一份,重复提交算「更新答案」(INSERT OR REPLACE)
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  safeParse,
  normAnswers,
} from "../../_utils.js";

export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能填写问卷", 401);

  const id = parseInt(params.id, 10);
  if (!id) return fail("问卷编号不对");

  const row = await env.DB.prepare("SELECT id, open, questions FROM surveys WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail("这份问卷不存在", 404);
  if (!row.open) return fail("这份问卷已经截止了", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const na = normAnswers(safeParse(row.questions), payload.answers);
  if (na.error) return fail(na.error);

  await env.DB.prepare(
    "INSERT OR REPLACE INTO survey_answers (survey_id, user_id, answers, updated_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, me.id, JSON.stringify(na.answers), Date.now())
    .run();

  return json({ ok: true });
}
