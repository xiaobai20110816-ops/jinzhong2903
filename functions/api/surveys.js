/* ============================================================
   103 纪事 · 问卷(列表 / 创建)
   GET  /api/surveys        服主/管理员:全部问卷 + 每份答卷数
   POST /api/surveys        服主/管理员:新建一份问卷
   同学们填答走 survey.html?id=xx → /api/surveys/:id
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  isStaff,
  safeParse,
  normQuestions,
  SURVEY_MAX_TITLE,
  SURVEY_MAX_INTRO,
} from "./_utils.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主 / 管理员能管理问卷", 403);

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.intro, s.questions, s.open, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM survey_answers a WHERE a.survey_id = s.id) AS answers_count
       FROM surveys s
      ORDER BY s.created_at DESC, s.id DESC`
  ).all();

  return json({
    ok: true,
    surveys: (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      intro: r.intro,
      open: r.open ? 1 : 0,
      questions: safeParse(r.questions),
      answers_count: r.answers_count || 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主 / 管理员能管理问卷", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const title = String(payload.title || "").trim().slice(0, SURVEY_MAX_TITLE);
  if (!title) return fail("问卷还没写标题");
  const intro = String(payload.intro || "").trim().slice(0, SURVEY_MAX_INTRO);

  const nq = normQuestions(payload.questions);
  if (nq.error) return fail(nq.error);

  const now = Date.now();
  const open = payload.open === 0 ? 0 : 1;
  const res = await env.DB.prepare(
    "INSERT INTO surveys (title, intro, questions, open, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(title, intro, JSON.stringify(nq.questions), open, now, now)
    .run();

  return json({ ok: true, id: res.meta.last_row_id });
}
