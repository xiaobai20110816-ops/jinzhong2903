/* ============================================================
   103 纪事 · 个人中心
   POST /api/profile  { signature, avatar_key, display_name, wallpaper_key }
   改自己的个性签名、头像、昵称、个人主页壁纸;
   头像和壁纸都先走 /api/upload 拿到 key 再传进来
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  IMAGE_KEY_RE,
  GRADES,
  classNo,
  classLabel,
} from "./_utils.js";

const MAX_SIGNATURE = 40;
const MAX_DISPLAY_NAME = 16;

/* 昵称规则:去掉首尾空白、剔除换行 / 制表符等控制字符后,
   最多 16 个字;空串 = 清空昵称(显示时退回真名 / 账号名)。
   控制字符是要渲染出来的昵称里绝不该出现的东西,直接剔掉而不是原样存库 */
function cleanDisplayName(raw) {
  return String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!me) return fail("请先登录", 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  /* 只改班级信息。个人中心那个「补登记」的弹窗走这条路,
     免得只填个班号,却把签名 / 昵称 / 头像一起覆盖成空 */
  if (payload.action === "class") {
    const grade = String(payload.grade || "").trim();
    const cno = classNo(payload.classNo);
    if (GRADES.indexOf(grade) < 0) return fail("选一下自己是几年级的");
    if (!cno) return fail("班号填 1~99 之间的数字");
    await env.DB.prepare("UPDATE users SET grade = ?, class_no = ? WHERE id = ?")
      .bind(grade, cno, me.id)
      .run();
    return json({
      ok: true,
      user: { ...me, grade, class_no: cno, class_label: classLabel(grade, cno), classed: 1 },
    });
  }

  const signature = String(payload.signature ?? "").trim().slice(0, MAX_SIGNATURE);
  const avatarKey = String(payload.avatar_key ?? "").trim();
  const displayName = cleanDisplayName(payload.display_name);
  const wallpaperKey = String(payload.wallpaper_key ?? "").trim();

  // 头像要么清空,要么必须是我们自己上传时生成的那种 key
  if (avatarKey && !IMAGE_KEY_RE.test(avatarKey)) return fail("头像地址不对，重新传一次吧");
  // 昵称超长就退回去改,不悄悄截断 —— 用户看到的必须是 TA 自己写的
  if (displayName.length > MAX_DISPLAY_NAME) return fail("昵称 1~16 个字");
  // 壁纸同理:要么清空,要么是上传生成的那种 key
  if (wallpaperKey && !IMAGE_KEY_RE.test(wallpaperKey)) return fail("壁纸地址不对，重新传一次吧");

  const old = await env.DB.prepare("SELECT avatar_key, wallpaper_key FROM users WHERE id = ?")
    .bind(me.id)
    .first();

  await env.DB.prepare(
    "UPDATE users SET signature = ?, avatar_key = ?, display_name = ?, wallpaper_key = ? WHERE id = ?"
  )
    .bind(signature, avatarKey || null, displayName, wallpaperKey || null, me.id)
    .run();

  // 换了头像 / 壁纸,把旧图从 KV 里清掉,别白占免费额度
  const staleAvatar = old && old.avatar_key;
  const staleWall = old && old.wallpaper_key;
  if (env.STORY_KV) {
    if (staleAvatar && staleAvatar !== avatarKey && IMAGE_KEY_RE.test(staleAvatar)) {
      await env.STORY_KV.delete("img:" + staleAvatar).catch(() => {});
    }
    if (staleWall && staleWall !== wallpaperKey && IMAGE_KEY_RE.test(staleWall)) {
      await env.STORY_KV.delete("img:" + staleWall).catch(() => {});
    }
  }

  return json({
    ok: true,
    user: { ...me, signature, avatar: avatarKey, display_name: displayName, wallpaper_key: wallpaperKey },
  });
}
