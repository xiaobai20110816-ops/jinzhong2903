/* ============================================================
   103 · B2 存储配置接口
   GET  /api/b2              读配置(密钥只回显尾号)
   PUT  /api/b2              保存配置
   POST /api/b2  { action }  测试连接(密钥 / S3 签名 / 桶)

   只有服主能用。密钥存在 D1 settings 表里,环境变量优先。
   桶是私有的(见 _b2.js 开头),图片由 /api/gallery/img 代理读取。
   ============================================================ */

import {
  json,
  fail,
  notReady,
  ensureSchema,
  currentUser,
  putSetting,
} from "./_utils.js";
import {
  b2Config,
  b2Authorize,
  b2ListBuckets,
  s3Probe,
} from "./_b2.js";

function ownerOnly(me) {
  return !!me && me.role === "owner";
}

/* 把密钥遮起来:只留尾 4 位,让人知道「存过了」,又不至于每次刷新都把明文摊在屏幕上 */
function maskKey(v) {
  const s = String(v || "");
  return s.length > 4 ? "····" + s.slice(-4) : s ? "····" : "";
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!ownerOnly(me)) return fail("只有服主能看 B2 配置", 403);

  const cfg = await b2Config(env, env.DB);
  return json({
    ok: true,
    config: {
      keyId: cfg.keyId,
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      hasKey: !!cfg.appKey,
      appKeyHint: maskKey(cfg.appKey),
      ready: cfg.ready,
    },
  });
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!ownerOnly(me)) return fail("只有服主能改 B2 配置", 403);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail("提交的内容读不出来，刷新页面再试");
  }

  await putSetting(env.DB, "b2_key_id", String(body.keyId || "").trim());
  await putSetting(env.DB, "b2_endpoint", String(body.endpoint || "").trim());
  await putSetting(env.DB, "b2_bucket", String(body.bucket || "").trim());
  // 密钥留空 = 不覆盖(界面上回显的是尾号,不能拿它当新密钥写回去)
  const appKey = String(body.appKey || "").trim();
  if (appKey) await putSetting(env.DB, "b2_app_key", appKey);

  const cfg = await b2Config(env, env.DB);
  return json({
    ok: true,
    ready: cfg.ready,
    message: cfg.ready
      ? "已保存，之后上传的照片和视频都会存进 B2，由本站代理读取并缓存到边缘节点"
      : "已保存，但还差 keyID / applicationKey / Endpoint / 桶名，原图暂时还是存 KV",
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return notReady("数据库");
  await ensureSchema(env.DB);

  const me = await currentUser(request, env);
  if (!ownerOnly(me)) return fail("只有服主能操作 B2", 403);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail("请求读不出来，刷新页面再试");
  }

  const saved = await b2Config(env, env.DB);

  // 表单里没填的就用已保存的;密钥留空也沿用已保存的那把
  const cfg = {
    keyId: String(body.keyId || "").trim() || saved.keyId,
    appKey: String(body.appKey || "").trim() || saved.appKey,
    endpoint: String(body.endpoint || "").trim() || saved.endpoint,
    bucket: String(body.bucket || "").trim() || saved.bucket,
  };
  cfg.endpoint = cfg.endpoint.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  cfg.endpoint = cfg.endpoint ? "https://" + cfg.endpoint : "";
  cfg.bucket = cfg.bucket.replace(/\s+/g, "");
  cfg.region = (cfg.endpoint.replace(/^https?:\/\//i, "").split(".")[1]) || "";
  cfg.ready = !!(cfg.keyId && cfg.appKey && cfg.endpoint && cfg.bucket);

  if (!cfg.keyId || !cfg.appKey)
    return fail("先填 keyID 和 applicationKey（B2 控制台 → Application Keys）");

  /* ---- 第一步:原生 API 授权。密钥不对这里就断了 ---- */
  let auth = null;
  try {
    auth = await b2Authorize(cfg.keyId, cfg.appKey);
  } catch (e) {
    return fail(e.message, 400);
  }

  // 拿到 S3 地址后,即使表单没填也能继续往下测
  if (!cfg.endpoint && auth.s3ApiUrl) {
    cfg.endpoint = auth.s3ApiUrl.replace(/\/+$/, "");
    cfg.region = cfg.endpoint.replace(/^https?:\/\//i, "").split(".")[1] || "";
  }

  /* ---- 第二步:列桶,顺便确认「到底有没有桶」 ---- */
  let buckets = [];
  try {
    buckets = await b2ListBuckets(auth);
  } catch (e) {
    return fail("密钥没问题，但列不出桶：" + e.message, 400);
  }

  const report = [
    { name: "密钥", ok: true, text: "keyID / applicationKey 有效（账号 " + auth.accountId + "）" },
    {
      name: "S3 地址",
      ok: !!cfg.endpoint,
      text: cfg.endpoint
        ? cfg.endpoint + "（区域 " + cfg.region + "）"
        : "没取到 S3 Endpoint，请去 B2 控制台「桶详情」里抄一份填上",
    },
    {
      name: "桶",
      ok: buckets.length > 0,
      text: buckets.length
        ? "找到 " + buckets.length + " 个桶：" + buckets.map((b) => b.name + (b.public ? "(公开)" : "(私有)")).join("、")
        : "账号下还没有桶 —— 先去 B2 控制台建一个（Buckets → Create a Bucket）",
    },
  ];

  if (!cfg.bucket) {
    report.push({ name: "已选桶", ok: false, text: "还没选桶" });
  } else {
    const hit = buckets.filter((b) => b.name === cfg.bucket)[0] || null;
    if (!hit) {
      report.push({ name: "已选桶", ok: false, text: "账号里没有叫「" + cfg.bucket + "」的桶，检查拼写" });
    } else {
      // 桶是私有的才好:本站用签名去取,不给外人直连,也不占公开桶的额外费用
      report.push({
        name: "桶权限",
        ok: true,
        text: hit.public ? "这个桶是公开的 —— 能用，但建议在 B2 里改回私有，本站代理读取不需要公开" : "私有桶（正常，本站会用签名代理读取）",
      });
      /* ---- 第三步:S3 签名实测(真正验证 SigV4 写对没有) ---- */
      if (cfg.endpoint) {
        try {
          const r = await s3Probe(cfg);
          report.push({
            name: "S3 读写",
            ok: true,
            text: "SigV4 签名通过（成功列出 " + r.objects + " 个对象）",
          });
        } catch (e) {
          report.push({ name: "S3 读写", ok: false, text: e.message });
        }
      }
    }
  }

  return json({
    ok: true,
    accountId: auth.accountId,
    s3ApiUrl: auth.s3ApiUrl || cfg.endpoint,
    downloadUrl: auth.downloadUrl,
    buckets,
    report,
    allOk: report.every((r) => r.ok),
  });
}
