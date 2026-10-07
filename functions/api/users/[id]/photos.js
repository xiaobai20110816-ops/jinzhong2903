/* ============================================================
   103 · 个人主页相册
   PUT /api/users/:id/photos   { photos: [图片 key, ...] }

   整份替换用户的相册(最多 9 张)。只有本人或服主能改。
   前端已经先把图传到 /api/upload 拿到 key,这里只负责校验并落库。
   ============================================================ */

import { json, fail, notReady, ensureSchema, currentUser, classGate, IMAGE_KEY_RE, ROLE_OWNER } from "../../_utils.js";

const MAX_PHOTOS = 9;

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  const gate = classGate(me);
  if (gate) return gate;

  const id = parseInt(params.id, 10);
  if (!id) return fail("成员编号不对");

  // 只能改自己的相册;服主可以替别人整理
  if (me.id !== id && me.role !== ROLE_OWNER) return fail("只能改自己的照片", 403);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，请刷新页面重试");
  }

  const raw = payload && payload.photos;
  if (!Array.isArray(raw)) return fail("照片列表格式不对");
  if (raw.length > MAX_PHOTOS) return fail(`最多只能放 ${MAX_PHOTOS} 张照片`);

  // 每一项都必须是 /api/upload 生成的那种 key,挡住任意字符串
  const list = raw.map(String);
  if (list.some((k) => !IMAGE_KEY_RE.test(k))) return fail("有照片地址不合法，重新传一次吧");

  await env.DB.prepare("UPDATE users SET photos = ? WHERE id = ?")
    .bind(JSON.stringify(list), id)
    .run();

  return json({ ok: true, photos: list });
}
