/* ============================================================
   103 纪事 · 单份问卷
   GET    /api/surveys/:id            登录用户:问卷内容 + 我填过的答案
   GET    /api/surveys/:id?stats=1    服主/管理员:统计(单选计数 + 填空答案列表)
   PUT    /api/surveys/:id            服主/管理员:改标题 / 说明 / 题目 / 开关
   DELETE /api/surveys/:id            服主/管理员:删问卷,连带删掉所有答卷
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
  loadAuthors,
  SURVEY_MAX_TITLE,
  SURVEY_MAX_INTRO,
} from "../_utils.js";

function toSurvey(row) {
  return {
    id: row.id,
    title: row.title,
    intro: row.intro || "",
    open: row.open ? 1 : 0,
    questions: safeParse(row.questions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* 统计:单选 → 每个选项多少人;填空 → 答案列表(带作者) */
async function loadStats(db, row, me) {
  const { results } = await db
    .prepare("SELECT user_id, answers, updated_at FROM survey_answers WHERE survey_id = ? ORDER BY updated_at ASC")
    .bind(row.id)
    .all();
  const list = results || [];
  const authors = await loadAuthors(db, list, me);

  const questions = safeParse(row.questions);
  const stats = questions.map((q) => {
    if (q.type === "choice") {
      return {
        type: "choice",
        title: q.title,
        // 每个选项一个计数,下标和 options 对齐
        options: (q.options || []).map((text) => ({ text, count: 0 })),
      };
    }
    return { type: "text", title: q.title, answers: [] };
  });

  for (const r of list) {
    const answers = safeParse(r.answers);
    const author = authors.get(r.user_id) || null;
    for (let i = 0; i < stats.length; i++) {
      const st = stats[i];
      const a = answers[i];
      if (st.type === "choice") {
        const n = typeof a === "number" ? a : parseInt(a, 10);
        if (Number.isInteger(n) && st.options[n]) st.options[n].count++;
      } else {
        const t = String(a == null ? "" : a).trim();
        if (t) st.answers.push({ body: t, author });
      }
    }
  }

  return { total: list.length, stats };
}

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const id = parseInt(params.id, 10);
  if (!id) return fail("问卷编号不对");

  const me = await currentUser(request, env);
  if (!me) return fail("登录后才能查看问卷", 401);

  const row = await env.DB.prepare("SELECT * FROM surveys WHERE id = ?").bind(id).first();
  if (!row) return fail("这份问卷不存在", 404);

  const url = new URL(request.url);
  if (url.searchParams.get("stats") === "1") {
    if (!isStaff(me)) return fail("只有服主 / 管理员能看统计", 403);
    const { total, stats } = await loadStats(env.DB, row, me);
    return json({ ok: true, survey: toSurvey(row), total, stats });
  }

  // 我填过的答案:回填用,按钮变成「更新答案」
  const mine = await env.DB.prepare(
    "SELECT answers, updated_at FROM survey_answers WHERE survey_id = ? AND user_id = ?"
  )
    .bind(id, me.id)
    .first();

  return json({
    ok: true,
    survey: toSurvey(row),
    my_answers: mine ? safeParse(mine.answers) : [],
    answered_at: mine ? mine.updated_at : 0,
  });
}

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主 / 管理员能管理问卷", 403);

  const id = parseInt(params.id, 10);
  if (!id) return fail("问卷编号不对");

  const row = await env.DB.prepare("SELECT * FROM surveys WHERE id = ?").bind(id).first();
  if (!row) return fail("这份问卷不存在", 404);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  // 都是「传了就改,没传不动」,方便后台只改一个开关
  let title = row.title;
  if (payload.title != null) {
    title = String(payload.title || "").trim().slice(0, SURVEY_MAX_TITLE);
    if (!title) return fail("问卷还没写标题");
  }
  let intro = row.intro || "";
  if (payload.intro != null) intro = String(payload.intro || "").trim().slice(0, SURVEY_MAX_INTRO);
  let questionsJson = row.questions;
  if (payload.questions != null) {
    const nq = normQuestions(payload.questions);
    if (nq.error) return fail(nq.error);
    questionsJson = JSON.stringify(nq.questions);
  }
  let open = row.open ? 1 : 0;
  if (payload.open != null) open = payload.open ? 1 : 0;

  await env.DB.prepare(
    "UPDATE surveys SET title = ?, intro = ?, questions = ?, open = ?, updated_at = ? WHERE id = ?"
  )
    .bind(title, intro, questionsJson, open, Date.now(), id)
    .run();

  return json({ ok: true });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主 / 管理员能管理问卷", 403);

  const id = parseInt(params.id, 10);
  if (!id) return fail("问卷编号不对");

  const row = await env.DB.prepare("SELECT id FROM surveys WHERE id = ?").bind(id).first();
  if (!row) return fail("这份问卷不存在", 404);

  await env.DB.prepare("DELETE FROM survey_answers WHERE survey_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM surveys WHERE id = ?").bind(id).run();

  return json({ ok: true });
}
