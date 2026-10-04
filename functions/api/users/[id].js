/* ============================================================
   103 · 单个成员
   GET    /api/users/:id   读 TA 的资料(公开)+ 点赞数 + TA 发过多少主帖
   PUT    /api/users/:id   改账号(仅服主):{ role?, username?, password?, banned? }
   DELETE /api/users/:id   彻底删掉这个账号(仅服主)

   删账号的取舍:
   - 会话一起清掉,那台设备立刻掉线
   - 用户名释放出来,可以再被注册
   - 但 TA 发过的留言保留,只把 user_id 置空,变成和以前一样的「老帖」
   自己那一行不允许改角色、不允许封自己、也不允许删自己(防止把唯一的管理权弄没了),
   但别的账号(包括早期遗留的另一个服主账号)服主都能改、能删、能改名。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  hashPassword,
  randomHex,
  USERNAME_RE,
  isStaff,
  namedUser,
  safeParse,
  certLevel,
  CERT_LEVELS,
  ROLE_OWNER,
  ROLE_ADMIN,
} from "../_utils.js";

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 64;
const MAX_REAL_NAME = 24;
const MAX_CERT_TITLE = 20;

/* ---- 班级成就:三项指标达到阈值就自动解锁称号,展示在个人名片上 ----
   指标全部现算,不建表也不存状态 —— 数据本来就是现成的,存一份反而要对账 */
const ACHIEVEMENTS = [
  { key: "posts", name: "笔杆子", desc: "发布 10 条主帖", need: 10 },
  { key: "likes", name: "人气王", desc: "个人主页被赞 5 次", need: 5 },
  { key: "replies", name: "社交达人", desc: "评论过 10 个人", need: 10 },
];

const loadUser = (db, id) =>
  db
    .prepare(
      "SELECT id, username, role, avatar_key, signature, banned, real_name, verified, cert_title, cert_level, photos, created_at FROM users WHERE id = ?"
    )
    .bind(id)
    .first();

export async function onRequestGet({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");

  const row = await loadUser(env.DB, id);
  if (!row) return fail("找不到这个人", 404);

  const me = await currentUser(request, env);
  // 被封禁的人对外等于不存在,只有服主/管理员还能看到 TA 的资料
  if (row.banned && !isStaff(me)) return fail("找不到这个人", 404);

  const likeRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM profile_likes WHERE to_id = ?"
  )
    .bind(id)
    .first();

  let liked = 0;
  if (me) {
    const mine = await env.DB.prepare(
      "SELECT 1 AS x FROM profile_likes WHERE from_id = ? AND to_id = ?"
    )
      .bind(me.id, id)
      .first();
    liked = mine ? 1 : 0;
  }

  const postRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND parent_id IS NULL AND wall_id IS NULL"
  )
    .bind(id)
    .first();

  // 「评论过多少人」:回复过的楼主 + 在他主页留过言的人,两边并起来去重
  const peopleRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT p2.user_id AS uid
         FROM posts p JOIN posts p2 ON p2.id = p.reply_to_id
        WHERE p.user_id = ? AND p2.user_id IS NOT NULL AND p2.user_id <> p.user_id
       UNION
       SELECT p.wall_id AS uid
         FROM posts p
        WHERE p.user_id = ? AND p.wall_id IS NOT NULL AND p.wall_id <> p.user_id
     )`
  )
    .bind(id, id)
    .first()
    .catch(() => null);

  const counts = {
    posts: Number(postRow ? postRow.n : 0) || 0,
    likes: Number(likeRow ? likeRow.n : 0) || 0,
    replies: Number(peopleRow ? peopleRow.n : 0) || 0,
  };
  const achievements = ACHIEVEMENTS.map((a) => ({
    key: a.key,
    name: a.name,
    desc: a.desc,
    need: a.need,
    now: counts[a.key],
    got: counts[a.key] >= a.need,
  }));

  // 真名按「看的人」的权限下发:服主 / 管理员 / 已实名的同学才看得到
  const shown = namedUser(row, me);

  return json({
    ok: true,
    me: me ? me.id : 0,
    liked,
    likes: likeRow ? likeRow.n : 0,
    postCount: postRow ? postRow.n : 0,
    achievements,
    user: {
      ...shown,
      signature: row.signature || "",
      banned: row.banned ? 1 : 0,
      // 相册对所有人公开,谁来主页都看得到
      photos: safeParse(row.photos),
      created_at: row.created_at,
    },
  });
}

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!isStaff(me)) return fail("只有服主和管理员能改账号", 403);
  const isOwner = me.role === ROLE_OWNER;

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");

  const row = await loadUser(env.DB, id);
  if (!row) return fail("找不到这个成员", 404);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  // 管理员只负责「实名审核」这一件事:能填真名、能点通过 / 取消;
  // 改角色、改名、重置密码、封禁、删除仍然只有服主能做
  if (!isOwner) {
    const keys = Object.keys(payload || {});
    if (!keys.length || !keys.every((k) => k === "real_name" || k === "verified")) {
      return fail("管理员只能填写真名和审核实名", 403);
    }
  }

  // 审核通过必须有真名,否则「学生风采」上会出现一个空名字
  if (payload.verified) {
    const willBe = payload.real_name !== undefined ? payload.real_name : row.real_name;
    if (!String(willBe == null ? "" : willBe).trim()) return fail("先把真名填上，再点审核通过");
  }

  // 自己这一行只允许改名和换密码:自己把自己的管理权摘了、或把自己封了,
  // 会把站点锁死没人能救,所以这两样直接挡掉。别人的账号(哪怕是另一个服主)不限制。
  if (id === me.id) {
    if (payload.role !== undefined) return fail("不能改自己的角色");
    if (payload.banned !== undefined) return fail("不能封禁自己");
  }

  // 一次可能改好几样,攒成一条 UPDATE,避免改一半
  const sets = [];
  const binds = [];
  const changed = [];
  let newName = "";

  if (payload.role !== undefined) {
    const role = String(payload.role || "");
    if (role !== ROLE_ADMIN && role !== "member") return fail("只能设为管理员或普通成员");
    sets.push("role = ?");
    binds.push(role);
    changed.push("角色");
  }

  if (payload.username !== undefined) {
    newName = String(payload.username || "").trim();
    if (!USERNAME_RE.test(newName)) {
      return fail("用户名 2~16 位，中文、字母、数字、下划线都可以");
    }
    if (newName !== row.username) {
      const dup = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
        .bind(newName)
        .first();
      if (dup) return fail("这个名字已经有人用了，换一个吧", 409);
    }
    sets.push("username = ?");
    binds.push(newName);
    changed.push("用户名");
  }

  if (payload.password !== undefined) {
    const pw = String(payload.password || "");
    if (pw.length < MIN_PASSWORD) return fail(`密码至少 ${MIN_PASSWORD} 位`);
    if (pw.length > MAX_PASSWORD) return fail("密码太长了，换短一点的");
    const salt = randomHex(8);
    sets.push("salt = ?", "pass_hash = ?");
    binds.push(salt, await hashPassword(pw, salt));
    changed.push("密码");
  }

  if (payload.banned !== undefined) {
    const banned = payload.banned ? 1 : 0;
    sets.push("banned = ?");
    binds.push(banned);
    changed.push(banned ? "封禁" : "解封");
  }

  // 实名:填真名 / 审核通过 / 取消实名
  if (payload.real_name !== undefined) {
    const rn = String(payload.real_name || "").trim().slice(0, MAX_REAL_NAME);
    sets.push("real_name = ?");
    binds.push(rn);
    changed.push("真名");
  }

  if (payload.verified !== undefined) {
    const v = payload.verified ? 1 : 0;
    sets.push("verified = ?");
    binds.push(v);
    changed.push(v ? "审核通过" : "取消实名");
  }

  // 官方认证头衔 + 级别:只有服主能写(上面已把管理员的字段锁死成 real_name / verified)。
  // 头衔传空字符串就是清除认证,顺手把级别也归零,免得留下一个没有头衔的级别。
  if (payload.cert_title !== undefined) {
    const cert = String(payload.cert_title || "").trim().slice(0, MAX_CERT_TITLE);
    sets.push("cert_title = ?");
    binds.push(cert);
    const lv = cert ? certLevel(payload.cert_level) : "";
    sets.push("cert_level = ?");
    binds.push(lv);
    changed.push("官方认证");
  } else if (payload.cert_level !== undefined) {
    // 只改级别时也校验一下,避免写进奇怪的值
    const lv = certLevel(payload.cert_level);
    if (payload.cert_level && !CERT_LEVELS.includes(lv)) return fail("认证级别只能是金 / 红 / 黑");
    sets.push("cert_level = ?");
    binds.push(lv);
    changed.push("官方认证");
  }

  if (!sets.length) return fail("没有要改的内容");

  binds.push(id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  // 帖子里存的是发帖那一刻的署名,改名后旧帖一起换掉,不然留言板还挂着老名字
  if (newName && newName !== row.username) {
    await env.DB.prepare("UPDATE posts SET name = ? WHERE user_id = ?").bind(newName, id).run();
    await env.DB.prepare("UPDATE posts SET name = ? WHERE wall_id = ?").bind(newName, id).run();
  }

  // 封禁要立刻生效:把 TA 的会话全删掉,而不是等 Cookie 过期
  if (payload.banned) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }

  return json({ ok: true, id, changed });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me || me.role !== ROLE_OWNER) return fail("只有服主能删除账号", 403);

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");
  if (id === me.id) return fail("不能删自己");

  const row = await loadUser(env.DB, id);
  if (!row) return fail("找不到这个成员", 404);

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("UPDATE posts SET user_id = NULL WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM profile_likes WHERE from_id = ? OR to_id = ?").bind(id, id).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

  return json({ ok: true, id, name: row.username });
}
