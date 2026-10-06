/* ============================================================
   103 纪事 · Backblaze B2 客户端
   ------------------------------------------------------------
   为什么用 B2:KV 单值上限 25MiB,视频根本放不下;R2 要绑卡,
   B2 不要。B2 是 Cloudflare Bandwidth Alliance 成员,B2 → CF
   这段流量免费,所以「Function 代理 + 边缘缓存」不花出流量钱。

   为什么不是「公开桶 + CDN 直连」:
   B2 现在不允许没有付款记录的新账号把桶设成 allPublic
   (b2_update_bucket 直接回 no_payment_history)。学生没有信用卡,
   所以桶只能是私有的,由本站 Function 签名去 B2 取流再转发,
   顺手写进 caches.default,同一张图第二次打开就走边缘缓存。

   这里手写两套调用:
   1) 原生 B2 API —— 只用来「测试连接(验证密钥 + 列桶)」
      鉴权是最朴素的 Basic(keyID:applicationKey)。
   2) S3 兼容 API —— 上传 / 读取 / 删除,用 AWS SigV4 签名,
      路径走 path-style:https://s3.<region>.backblazeb2.com/<桶>/<key>

   注意:主应用程序密钥(keyID = 12 位账号 ID)不能用于 S3 接口,
   B2 会回 InvalidAccessKeyId / Malformed Access Key Id。
   必须去控制台 Application Keys 里单独建一把,S3 用它的 keyID。

   文件名以下划线开头,不会被当成路由。
   ============================================================ */

import { getSetting } from "./_utils.js";

const TE = new TextEncoder();

/* ---------- 小工具 ---------- */

const toHex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256hex(data) {
  const input = typeof data === "string" ? TE.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", input));
}

export async function hmacSha256(key, data) {
  const k = typeof key === "string" ? TE.encode(key) : key;
  const d = typeof data === "string" ? TE.encode(data) : data;
  const ck = await crypto.subtle.importKey(
    "raw",
    k,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, d));
}

/* keyID / applicationKey 都是十六进制 ASCII,直接 btoa 就是合法的 Basic 凭据 */
const b64 = (s) => btoa(s);

/* ---------- 配置读取:环境变量优先,回落 D1 settings ---------- */

const FIELDS = {
  keyId: ["B2_KEY_ID", "b2_key_id"],
  appKey: ["B2_APP_KEY", "b2_app_key"],
  endpoint: ["B2_ENDPOINT", "b2_endpoint"],
  bucket: ["B2_BUCKET", "b2_bucket"],
};

export const B2_SETTING_KEYS = Object.values(FIELDS).map((p) => p[1]);

/* 用户可能粘成 "s3.us-west-004.backblazeb2.com" 或带 http:// 或带结尾斜杠,统一成 https://host */
function normalizeEndpoint(v) {
  let s = String(v || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return s ? "https://" + s : "";
}

export function regionOfEndpoint(endpoint) {
  const host = String(endpoint || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = host.split(".");
  // s3.us-west-004.backblazeb2.com → us-west-004
  return parts.length > 1 ? parts[1] : "";
}

export async function b2Config(env, db) {
  const out = { keyId: "", appKey: "", endpoint: "", bucket: "" };
  for (const field of Object.keys(FIELDS)) {
    const [envName, dbName] = FIELDS[field];
    let v = env && env[envName] ? String(env[envName]).trim() : "";
    if (!v && db) v = ((await getSetting(db, dbName).catch(() => "")) || "").trim();
    out[field] = v;
  }
  out.endpoint = normalizeEndpoint(out.endpoint);
  out.bucket = out.bucket.replace(/\s+/g, "");
  out.region = regionOfEndpoint(out.endpoint);
  out.ready = !!(out.keyId && out.appKey && out.endpoint && out.bucket);
  return out;
}

/* ---------- key 约定 ----------
   库里存的 key 是 <hex>.full.jpg / <hex>.thumb.jpg;
   存到 B2 的原图会多一个 "b2-" 前缀,用来区分「在 KV 还是在 B2」。
   B2 里的对象名 = "img/" + 去掉前缀的 key(1:1 可逆,不用额外加列)。 */

export const B2_PREFIX = "b2-";

export function isB2Key(key) {
  return typeof key === "string" && key.startsWith(B2_PREFIX);
}

export function b2ObjectName(dbKey) {
  return "img/" + String(dbKey).slice(B2_PREFIX.length);
}

/* ---------- SigV4 签名 ---------- */

function canonicalQuery(params) {
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort();
  return keys
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
}

async function signV4({ method, host, path, query, region, keyId, appKey, bodyBytes }) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256hex(bodyBytes || new Uint8Array(0));

  const canonicalHeaders =
    "host:" + host + "\n" +
    "x-amz-content-sha256:" + payloadHash + "\n" +
    "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = dateStamp + "/" + region + "/s3/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256("AWS4" + appKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    amzDate,
    payloadHash,
    authorization:
      "AWS4-HMAC-SHA256 Credential=" + keyId + "/" + scope +
      ", SignedHeaders=" + signedHeaders +
      ", Signature=" + signature,
  };
}

/* 把 S3 的错误 XML 抠成一句人话 */
async function s3Error(res) {
  const text = await res.text().catch(() => "");
  const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || "";
  const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || "";
  // 最常见的坑:拿主应用程序密钥(keyID = 12 位账号 ID)来签 S3,B2 一律回这句
  if (code === "InvalidAccessKeyId")
    return "B2 不认这把密钥。S3 接口要用「Application Keys」里单独建的那把（keyID 是 24 位左右的一长串，不是 12 位的账号 ID）；主密钥只能用于原生接口";
  if (code || msg) return "B2 拒绝了这次请求：" + [code, msg].filter(Boolean).join(" · ");
  if (res.status === 403) return "B2 拒绝了这次请求（403）：密钥没有这个桶的权限，或桶名 / Endpoint 写错了";
  return "B2 返回 HTTP " + res.status;
}

/* ---------- S3 兼容接口 ---------- */

async function s3Request(cfg, opts) {
  const host = String(cfg.endpoint).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const region = cfg.region;
  const key = opts.key || "";
  const path =
    "/" + cfg.bucket + (key ? "/" + key.split("/").map(encodeURIComponent).join("/") : "");
  const query = canonicalQuery(opts.query || {});
  const bodyBytes =
    opts.body == null ? null : typeof opts.body === "string" ? TE.encode(opts.body) : opts.body;

  const sig = await signV4({
    method: opts.method,
    host,
    path,
    query,
    region,
    keyId: cfg.keyId,
    appKey: cfg.appKey,
    bodyBytes,
  });

  const headers = {
    authorization: sig.authorization,
    "x-amz-date": sig.amzDate,
    "x-amz-content-sha256": sig.payloadHash,
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;
  // 额外的头(range 之类)不参与签名,B2 只要求 host / x-amz-* 进签名
  if (opts.extraHeaders) {
    for (const k of Object.keys(opts.extraHeaders)) headers[k] = opts.extraHeaders[k];
  }

  return fetch("https://" + host + path + (query ? "?" + query : ""), {
    method: opts.method,
    headers,
    body: bodyBytes || undefined,
  });
}

export async function s3Put(cfg, key, bytes, contentType) {
  const res = await s3Request(cfg, {
    method: "PUT",
    key,
    body: bytes,
    contentType: contentType || "application/octet-stream",
  });
  if (!res.ok) throw new Error(await s3Error(res));
  return true;
}

/* 读一个对象,把 B2 的原始响应交回去(状态码 / 头 / body 流都不动)。
   桶是私有的,所以必须带着签名来取;range 直接透传,视频才能拖动进度。 */
export function s3Get(cfg, key, range) {
  return s3Request(cfg, {
    method: "GET",
    key,
    extraHeaders: range ? { range: range } : null,
  });
}

export async function s3Delete(cfg, key) {
  const res = await s3Request(cfg, { method: "DELETE", key });
  // 404 = 本来就没有,当成删成功
  if (!res.ok && res.status !== 404) throw new Error(await s3Error(res));
  return true;
}

/* 测试连接:列 1 个对象。能过就说明 SigV4 签名、桶名、Endpoint 全都对 */
export async function s3Probe(cfg) {
  const res = await s3Request(cfg, {
    method: "GET",
    query: { "list-type": "2", "max-keys": "1" },
  });
  if (!res.ok) throw new Error(await s3Error(res));
  const text = await res.text();
  const n = (text.match(/<Key>/g) || []).length;
  return { objects: n };
}

/* ---------- 原生 B2 API(授权 / 列桶) ---------- */

const API_ROOT = "https://api.backblazeb2.com";

export async function b2Authorize(keyId, appKey) {
  const headers = { authorization: "Basic " + b64(keyId + ":" + appKey) };

  // 先试 v3:v3 会直接给出 S3 Endpoint(s3ApiUrl),省得用户自己猜区域
  let res = await fetch(API_ROOT + "/b2api/v3/b2_authorize_account", { headers });
  let d = await res.json().catch(() => ({}));
  if (!res.ok && (res.status === 404 || d.code === "bad_request")) {
    res = await fetch(API_ROOT + "/b2api/v2/b2_authorize_account", { headers });
    d = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "keyID 或 applicationKey 不对（B2 返回 401）"
        : "B2 授权失败：" + (d.message || d.code || "HTTP " + res.status)
    );
  }

  const st = (d.apiInfo && d.apiInfo.storageApi) || {};
  const allowed = st.allowed || d.allowed || {};
  return {
    accountId: d.accountId || "",
    token: d.authorizationToken || "",
    apiUrl: st.apiUrl || d.apiUrl || "",
    downloadUrl: st.downloadUrl || d.downloadUrl || "",
    s3ApiUrl: st.s3ApiUrl || d.s3ApiUrl || "",
    allowedBucket: allowed.bucketName || "",
    capabilities: (st.capabilities || allowed.capabilities || []).slice(0, 40),
  };
}

async function nativeCall(auth, name, body) {
  const res = await fetch(auth.apiUrl + "/b2api/v3/" + name, {
    method: "POST",
    headers: {
      authorization: auth.token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      "B2 " + name + " 失败：" + (d.message || d.code || "HTTP " + res.status)
    );
  }
  return d;
}

/* 列桶。只为「体检」用,真正干活的是下面的 S3 接口。
   注意:限定到某个桶的 Application Key 必须带上 bucketName,
   否则 B2 不区分「没权限」和「没指定桶」,统一回 401 unauthorized。 */
export async function b2ListBuckets(auth, bucketName) {
  const body = { accountId: auth.accountId };
  if (bucketName) body.bucketName = bucketName;
  const d = await nativeCall(auth, "b2_list_buckets", body);
  return (d.buckets || []).map((b) => ({
    id: b.bucketId || "",
    name: b.bucketName || "",
    type: b.bucketType || "",
    public: b.bucketType === "allPublic",
  }));
}
