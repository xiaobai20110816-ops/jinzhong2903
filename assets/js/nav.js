/* ============================================================
   103班：音乐领军班 · 全站公共脚本
   1) 动态注入导航栏 + 主题开关 + 底部信息栏
   2) 账号系统:window.C103Auth(登录 / 注册 / 退出 / 改资料)
   3) 开屏公告:每次更新改 SPLASH_* 常量,版本号一变所有设备重新弹一次
   所有页面共用这一份,子页面不用各自写导航和登录逻辑。
   ============================================================ */

// 导航配置：改了导航项,所有页面一起变
const NAV_ITEMS = [
  { href: "index.html", label: "首页" },
  { href: "students.html", label: "学生风采" },
  { href: "dormitory.html", label: "宿舍风采" },
  { href: "moments.html", label: "高光时刻" },
  { href: "gallery.html", label: "图库" },
  { href: "story.html", label: "103 纪事" },
  { href: "rank.html", label: "活跃榜" },
  { href: "announcements.html", label: "班级公告" },
  { href: "messages.html", label: "私信" },
];

// 主题存在 localStorage:dark(默认) / light
const THEME_KEY = "class103-theme";
const THEME_COLORS = { dark: "#070b14", light: "#f4f6fa" };

/* 皮肤:只换「点缀色 + 氛围柔光」,版式完全不动。
   classic 是默认色(不写 data-skin 属性),其余三套覆盖在 base.css 里 */
const SKIN_KEY = "class103-skin";
const SKINS = [
  { id: "classic", name: "鎏金", dots: ["#f0b90b", "#ff8a00"] },
  { id: "aurora", name: "极光", dots: ["#3fd8e8", "#7c8cff"] },
  { id: "rose", name: "蔷薇", dots: ["#ff7aa8", "#ffb37a"] },
  { id: "forest", name: "松林", dots: ["#4be3a0", "#ffd166"] },
];

function readTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  // 深色是默认值,直接摘掉属性,少一层覆盖
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else document.documentElement.removeAttribute("data-theme");

  // 手机浏览器地址栏跟着变色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[theme]);

  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 隐私模式下忽略 */ }
}

function readSkin() {
  const s = document.documentElement.dataset.skin || "";
  return SKINS.some((x) => x.id === s) ? s : "classic";
}

function applySkin(id) {
  const skin = SKINS.some((x) => x.id === id) ? id : "classic";
  if (skin === "classic") document.documentElement.removeAttribute("data-skin");
  else document.documentElement.dataset.skin = skin;
  try { localStorage.setItem(SKIN_KEY, skin); } catch (e) { /* 忽略 */ }
}

/* ============================================================
   账号:全站的登录状态都从这里取
   story.js / account.html 用 window.C103Auth
   ============================================================ */

const API = "api"; // 相对路径:官网根目录、子目录都能用

async function apiFetch(url, options) {
  const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "网络不太顺，稍后再试");
  return data;
}

// 同一台设备一个随机 id,只用来做「别发太快」的限流(全班共用校园网时不会互相卡住)
function deviceId() {
  try {
    let v = localStorage.getItem("class103-cid");
    if (!v) {
      v = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
      localStorage.setItem("class103-cid", v);
    }
    return v;
  } catch (e) {
    return "";
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const ROLE_LABEL = { owner: "服主", admin: "管理员" };

/* ============================================================
   名字 + 认证勾:全站统一按这一套渲染
   真名能不能看见是后端按权限决定的 —— 有 real_name 就是能看,
   verified=1 且带 real_name 才在名字后面缀一个蓝色小钩。
   服主(role === "owner")不挂蓝钩,换成金色的认证徽章 —— 一眼认得出服主。
   ============================================================ */

const BLUE_CHECK =
  '<svg class="nick-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="11" fill="#2f8bff"></circle>' +
  '<path d="M6.8 12.5l3.4 3.4L17.2 9" fill="none" stroke="#fff" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// 金色认证徽章:16 个角的锯齿圆盘(外 11.6 / 内 9.4)+ 白色对勾,仿推特的金色认证
const GOLD_CHECK =
  '<svg class="nick-check nick-owner" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M23.6 12l-2.2 2.5.5 3.3-3.1 1.2-1.2 3.1-3.3-.5L12 23.6l-2.5-2.2-3.3.5-1.2-3.1-3.1-1.2.5-3.3L.2 12l2.2-2.5-.5-3.3 3.1-1.2 1.2-3.1 3.3.5L12 .4l2.5 2.2 3.3-.5 1.2 3.1 3.1 1.2-.5 3.3L23.6 12Z" fill="#e8b325"></path>' +
  '<path d="M7.4 12.4l3.1 3.1 6.1-6.3" fill="none" stroke="#fffdf5" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// 官方认证药丸里的对勾:一枚实心圆 + 对勾,圆圈跟药丸文字色走,
// 对勾色由 CSS 的 --cert-ink 决定(黑底药丸上要反过来用深色勾,不能一律用 --bg0)
const CERT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="11" fill="currentColor"></circle>' +
  '<path class="tick" d="M7 12.4l3.2 3.2L17 8.8" fill="none" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// 官方认证的三个级别:金 / 红 / 黑。老数据只有头衔没级别,默认按金显示
const CERT_LEVELS = ["gold", "red", "black"];

const C103Person = {
  /* 该显示的名字:昵称优先(全站主名),其次能看真名时用真名,最后账号名 */
  name(person, fallback) {
    if (person) return person.display_name || person.real_name || person.name || fallback || "";
    return fallback || "";
  },
  /* 已实名的人,名字下面再压一行真名小字。
     真名能不能带出来由后端按权限 / 个人主页接口决定,这里只管渲染 */
  realLine(person) {
    if (!person || !person.verified || !person.real_name) return "";
    return '<i class="nick-real">' + esc(person.real_name) + "</i>";
  },
  /* 是否要缀蓝钩 */
  verified(person) {
    return !!(person && person.verified && person.real_name);
  },
  /* 是不是服主 */
  isOwner(person) {
    return !!(person && person.role === "owner");
  },
  /* 服主官方认证的头衔药丸:没设头衔就返回空串(头衔是公开信息,谁都能看)。
     级别决定配色,金 / 红 / 黑;没写或写了不认识的值一律按金处理 */
  cert(person) {
    const t = person && person.cert_title ? String(person.cert_title).trim() : "";
    if (!t) return "";
    const raw = person && person.cert_level ? String(person.cert_level).trim().toLowerCase() : "";
    const lv = CERT_LEVELS.includes(raw) ? raw : "gold";
    return '<i class="nick-cert is-' + lv + '">' + CERT_SVG + esc(t) + "</i>";
  },
  /* 名字 HTML(已转义)+ 认证勾 + 认证药丸:名字 → 金勾/蓝钩 → 药丸 */
  html(person, fallback) {
    const nm = esc(C103Person.name(person, fallback));
    const check = C103Person.isOwner(person)
      ? GOLD_CHECK
      : C103Person.verified(person)
      ? BLUE_CHECK
      : "";
    return nm + check + C103Person.cert(person);
  },
  /* 只要那个勾(给「回复 @某某」这种已经单独写了名字的地方用) */
  badge(person) {
    if (C103Person.isOwner(person)) return GOLD_CHECK;
    return C103Person.verified(person) ? BLUE_CHECK : "";
  },
  check: BLUE_CHECK,
  ownerCheck: GOLD_CHECK,
};

window.C103Person = C103Person;

/* ============================================================
   图片压缩:留言配图和头像共用同一套逻辑
   长边压到 1600 以内,质量从 0.85 逐档降到 0.45,还超标就缩尺寸,
   一直到 ≤1MB —— 手机上直出的几 MB 照片也能顺利上传
   ============================================================ */

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function decodeImage(file, maxEdge) {
  // createImageBitmap 能顺手按 EXIF 方向摆正,iPhone 竖拍的照片不会躺倒
  if (window.createImageBitmap) {
    const target = Math.max(1200, maxEdge || 1600);
    // 大文件(比如 20MB 的手机原图)按原比例解码成小图:
    // 不然 8000×6000 的位图在内存里要铺几百 MB,浏览器会卡到「无响应」。
    // 只传 resizeWidth,高度按原宽高比自动算;Chrome / Edge / Android 都支持
    if (file.size > 6 * 1024 * 1024) {
      try {
        return await createImageBitmap(file, {
          resizeWidth: target,
          resizeQuality: "high",
          imageOrientation: "from-image",
        });
      } catch (e) {
        // 个别浏览器不认 resize + orientation 的组合,去掉 orientation 再试
        try {
          return await createImageBitmap(file, {
            resizeWidth: target,
            resizeQuality: "high",
          });
        } catch (e2) {}
      }
    } else {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (e) {
        /* 个别浏览器不认这个选项,退回 <img> */
      }
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

const C103Image = {
  async compress(file, opts) {
    const maxEdge = (opts && opts.maxEdge) || 1600;
    const target = (opts && opts.targetBytes) || 1024 * 1024;

    let src;
    try {
      src = await decodeImage(file, maxEdge);
    } catch (e) {
      throw new Error("这张图浏览器读不出来（iPhone 的 HEIC 格式最常见），请在相册里先导出成 JPG 再传。");
    }

    const w0 = src.width || 1;
    const h0 = src.height || 1;
    const fit = Math.min(1, maxEdge / Math.max(w0, h0));
    let w = Math.max(1, Math.round(w0 * fit));
    let h = Math.max(1, Math.round(h0 * fit));

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let quality = 0.85;
    let blob = null;

    for (let round = 0; round < 10; round++) {
      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = "#ffffff"; // JPEG 没有透明通道,先铺白底免得透明区发黑
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);

      blob = await toBlob(canvas, quality);
      if (blob && blob.size <= target) break;

      if (quality > 0.46) {
        quality -= 0.12;
      } else {
        w = Math.max(1, Math.round(w * 0.8));
        h = Math.max(1, Math.round(h * 0.8));
        quality = 0.8;
      }
    }

    if (src.close) src.close();
    if (!blob) throw new Error("图片压缩失败了，换一张试试");

    // 原图本来就很小就别硬撑,直接用原文件更清楚
    if (blob.size > file.size && file.size <= target) return file;
    return blob;
  },
};

window.C103Image = C103Image;

/* 「记住我」:上次问到的账号资料留在 sessionStorage 里(只有 id / 名字 / 头像
   这些用来画界面的东西,不含任何 token)。同一标签页里刷新时先拿它把界面
   画出来,再去问服务器核对 —— 不会白一下,也不会因为一次网络抖动就变回未登录 */
const AUTH_CACHE_KEY = "class103-me";

function readAuthCache() {
  try {
    const v = JSON.parse(sessionStorage.getItem(AUTH_CACHE_KEY) || "null");
    return v && v.user ? v.user : null;
  } catch (e) {
    return null;
  }
}

function writeAuthCache(user) {
  try {
    if (user) sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ user: user }));
    else sessionStorage.removeItem(AUTH_CACHE_KEY);
  } catch (e) { /* 隐私模式写不进去,忽略 */ }
}

const C103Auth = {
  user: null,
  ready: null,
  _subs: [],

  onChange(fn) {
    this._subs.push(fn);
    fn(this.user);
  },

  _emit() {
    for (const fn of this._subs) {
      try { fn(this.user); } catch (e) { /* 单个回调出错不影响别人 */ }
    }
    renderAccount();
  },

  /* 问服务器「我是谁」。网络抖动、冷启动慢的时候重试两回,
     免得一次没连上就被当成未登录 */
  async _askMe(tries) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        // 顺手带上当前路径和设备 id:后端借这次请求记一笔页面浏览,
        // 统计不用额外再发一个请求
        const d = await apiFetch(
          API +
            "/auth/me?p=" +
            encodeURIComponent(location.pathname) +
            "&v=" +
            encodeURIComponent(deviceId())
        );
        return d.user || null; // 服务器明确回了 null,才是真的没登录
      } catch (err) {
        lastErr = err;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr;
  },

  refresh() {
    // 先把缓存里那个人摆上去:刷新页面时头像和名字立刻就在
    const cached = readAuthCache();
    if (cached) {
      this.user = cached;
      this._emit();
    }

    this.ready = this._askMe(3)
      .then((user) => {
        this.user = user;
        writeAuthCache(user);
        this._emit();
        return user;
      })
      .catch(() => {
        // 三次都没问通:留着缓存里的人,别让登录状态凭空消失
        if (!cached) {
          this.user = null;
          this._emit();
        }
        return this.user;
      });
    return this.ready;
  },

  async login(username, password) {
    const d = await apiFetch(API + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    });
    this.user = d.user;
    writeAuthCache(this.user);
    this._emit();
    return this.user;
  },

  async register(username, password) {
    const d = await apiFetch(API + "/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username, password: password, cid: deviceId() }),
    });
    this.user = d.user;
    writeAuthCache(this.user);
    this._emit();
    return this.user;
  },

  async logout() {
    try {
      await apiFetch(API + "/auth/logout", { method: "POST" });
    } catch (e) {
      /* 后端不认也得把本地状态清掉 */
    }
    this.user = null;
    writeAuthCache(null);
    this._emit();
    return null;
  },

  async saveProfile(fields) {
    const d = await apiFetch(API + "/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
    this.user = d.user;
    writeAuthCache(this.user);
    this._emit();
    return this.user;
  },
};

window.C103Auth = C103Auth;

/* ============================================================
   站点内容:全站文案 / 公告 / 学生 / 宿舍 / 高光都从这里取
   拉一次缓存在内存里,所有页面共用;后端没接上就返回 null,
   页面各自保留一份写死的兜底样子,永远不会空白。
   ============================================================ */
/* 站点内容缓存:半分钟内翻来覆去换页面时直接复用上一份,
   不再每次进页面都重新要一遍 —— 全班一起看的时候请求量能省掉一大截 */
const CONTENT_CACHE_KEY = "class103-content";
const CONTENT_TTL_MS = 30000;

const C103Content = {
  data: null,
  ready: null,
  _subs: [],

  onChange(fn) {
    this._subs.push(fn);
    if (this.data) fn(this.data);
  },

  _emit(data) {
    for (const fn of this._subs) {
      try { fn(data); } catch (e) { /* 单个回调出错不影响别人 */ }
    }
  },

  load() {
    if (this.ready) return this.ready;

    // 刚拉过就用缓存顶上,这一次请求直接省掉
    try {
      const c = JSON.parse(sessionStorage.getItem(CONTENT_CACHE_KEY) || "null");
      if (c && c.data && Date.now() - c.at < CONTENT_TTL_MS) {
        this.data = c.data;
        this._emit(this.data);
        this.ready = Promise.resolve(this.data);
        return this.ready;
      }
    } catch (e) { /* 缓存坏了就当没有 */ }

    this.ready = apiFetch(API + "/content")
      .then((d) => {
        this.data = d.content || null;
        this.cacheNow();
        this._emit(this.data);
        return this.data;
      })
      .catch(() => {
        this.data = null;
        this._emit(null);
        return null;
      });
    return this.ready;
  },

  /* 后台改完内容顺手调一下:把最新的一份写进缓存,
     别的页面翻过去立刻就是新的,不用等半分钟 */
  cacheNow() {
    try {
      if (this.data) {
        sessionStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify({ at: Date.now(), data: this.data }));
      }
    } catch (e) { /* 隐私模式写不进去,忽略 */ }
  },

  get(key) {
    return this.data ? this.data[key] : null;
  },
};

window.C103Content = C103Content;

/* 图片地址:后台新传的图是 KV 里的 key(32 位 hex),老图是仓库里的相对路径,
   两种写法都认,页面里统一用这个函数转一次 */
const IMG_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

function imgSrc(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  return IMG_KEY_RE.test(s) ? API + "/img/" + s : s;
}

window.C103Img = imgSrc;

/* 导航栏右侧的账号入口:没登录写「登录」,登录了显示头像/首字 */
function renderAccount() {
  const u = C103Auth.user;

  // 服主 / 管理员才看得到「管理后台」入口
  const adminLink = document.getElementById("nav-admin");
  if (adminLink) adminLink.hidden = !(u && (u.role === "owner" || u.role === "admin"));

  const btn = document.getElementById("nav-account");
  if (!btn) return;

  if (!u) {
    btn.classList.remove("is-in");
    btn.title = "登录 / 注册";
    btn.innerHTML =
      '<svg class="acc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.4" r="3.6"></circle><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0"></path></svg>' +
      '<span class="acc-text">登录</span>';
    return;
  }

  btn.classList.add("is-in");
  // 自己的真名 / 蓝钩同样按实名规则显示
  const shown = C103Person.name(u);
  btn.title = shown + (ROLE_LABEL[u.role] ? "（" + ROLE_LABEL[u.role] + "）" : "");
  const face = u.avatar
    ? `<img class="acc-avatar" src="${API}/img/${esc(u.avatar)}" alt="">`
    : `<span class="acc-avatar acc-letter">${esc(shown.slice(0, 1))}</span>`;
  const check = C103Person.verified(u) ? BLUE_CHECK : "";
  btn.innerHTML =
    face + '<span class="acc-text">' + esc(shown) + "</span>" + check;
}

/* ============================================================
   Markdown:极简、安全的渲染器(公告正文等富文本用)
   先把整段文本转义成 HTML 实体,再套一层白名单语法 ——
   所以就算有人贴 <script>,也只会原样显示成文字
   支持:标题(#~####)/ 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 /
        链接 / 无序列表 / 有序列表 / 引用 / 分割线
   ============================================================ */
window.C103Markdown = (function () {
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // 只放行安全协议,挡掉 javascript: 这类
  // 带协议(形如 xxx:)的只认 http(s) / mailto;不带协议的相对地址(api/img/x.jpg、/a、./a、#a)一律放行
  // 先去掉控制字符 —— 浏览器解析 URL 时会忽略它们,留着就容易拿 java\tscript: 这类绕过检查
  function safeUrl(u) {
    const s = String(u == null ? "" : u).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!s) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^(https?:|mailto:)/i.test(s) ? s : "";
    return s;
  }

  // 行内语法(输入必须是已转义的文本)
  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // 图片 ![说明](地址) —— 必须排在链接前面,否则里面那段 [说明](地址) 会先被当成链接
    t = t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const src = safeUrl(url);
      if (!src) return m;
      return '<img src="' + esc(src) + '" alt="' + alt + '" loading="lazy">';
    });
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeUrl(url);
      if (!href) return m;
      return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return t;
  }

  function render(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let para = [];
    let list = null; // { tag: "ul"|"ol", items: [] }

    const flushPara = () => {
      if (para.length) {
        out.push("<p>" + para.map(inline).join("<br>") + "</p>");
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push(
          "<" + list.tag + ">" + list.items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</" + list.tag + ">"
        );
        list = null;
      }
    };
    const flushAll = () => { flushPara(); flushList(); };

    while (i < lines.length) {
      const t = lines[i].trim();

      // 代码块 ``` ... ```
      if (/^```/.test(t)) {
        flushAll();
        i++;
        const buf = [];
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 收尾的 ```
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }

      if (!t) { flushAll(); i++; continue; }

      if (/^(-{3,}|\*{3,})$/.test(t)) { flushAll(); out.push("<hr>"); i++; continue; }

      const h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushAll();
        const lv = h[1].length + 2; // # → h3,页面里 h1/h2 留给标题
        out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (/^>\s?/.test(t)) {
        flushAll();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + buf.map(inline).join("<br>") + "</blockquote>");
        continue;
      }

      const ul = t.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push(ul[1]);
        i++;
        continue;
      }

      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
        list.items.push(ol[1]);
        i++;
        continue;
      }

      flushList();
      para.push(t);
      i++;
    }
    flushAll();
    return out.join("");
  }

  // 纯文本版(去掉所有标记),给首页那种「只看一句摘要」的地方用
  function text(src) {
    return String(src == null ? "" : src)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { render: render, text: text, escape: esc };
})();

/* ============================================================
   Markdown 工具栏:给任意 textarea 上面挂一排按钮,点一下把语法插进输入框
   用法 C103Editor.mount(textarea, { upload })
     upload(file) 可选 —— 传了才有「图片」按钮,它要把文件传上去、返回图片地址
   ============================================================ */
window.C103Editor = (function () {
  function mount(ta, opts) {
    if (!ta || ta.dataset.mdBar) return null;
    opts = opts || {};

    const bar = document.createElement("div");
    bar.className = "md-bar";
    let busy = false;
    let file = null;
    let imgAt = 0; // 点「图片」那一刻的光标位置(选文件期间可能跑掉,先记下来)
    let imgEnd = 0;

    // 把 [s,e) 这段换成 text,并把光标放到 selStart..selEnd
    function put(text, s, e, selStart, selEnd) {
      ta.focus();
      if (typeof ta.setRangeText === "function") {
        ta.setRangeText(text, s, e, "end");
      } else {
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      }
      if (typeof selStart === "number") {
        ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
      }
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 加粗 / 斜体 / 代码:包住选中的字,没选就放一小段占位文字并选中
    function wrap(before, after, ph) {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || ph;
      put(before + sel + after, s, e, s + before.length, s + before.length + sel.length);
    }

    // 标题 / 列表 / 引用:作用在光标那一行;已经有同样的标记就取消
    function prefix(mark) {
      const s = ta.selectionStart;
      const v = ta.value;
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      let le = v.indexOf("\n", s);
      if (le === -1) le = v.length;
      const line = v.slice(ls, le);
      if (line.startsWith(mark)) {
        put(line.slice(mark.length), ls, le, Math.max(ls, s - mark.length));
      } else {
        put(mark + line, ls, le, s + mark.length);
      }
    }

    function link() {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || "链接文字";
      const at = s + sel.length + 3; // [] 后面那个 ( 的位置
      put("[" + sel + "](https://)", s, e, at, at + 8); // 顺手选中 https://
    }

    function setBusy(v) {
      busy = v;
      Array.prototype.forEach.call(bar.querySelectorAll(".md-btn"), (b) => { b.disabled = v; });
    }

    const items = [
      { label: "加粗", title: "加粗", run: () => wrap("**", "**", "加粗文字") },
      { label: "斜体", title: "斜体", run: () => wrap("*", "*", "斜体文字") },
      { label: "标题", title: "小标题", run: () => prefix("## ") },
      { label: "列表", title: "无序列表", run: () => prefix("- ") },
      { label: "引用", title: "引用一段", run: () => prefix("> ") },
      { label: "代码", title: "行内代码", run: () => wrap("`", "`", "代码") },
      { label: "链接", title: "插入链接", run: link },
    ];

    if (typeof opts.upload === "function") {
      items.push({
        label: "图片",
        title: "插入图片",
        run: () => {
          imgAt = ta.selectionStart;
          imgEnd = ta.selectionEnd;
          if (file) file.click();
        },
      });
      file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*";
      file.hidden = true;
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        file.value = "";
        if (!f) return;
        setBusy(true);
        try {
          const url = await opts.upload(f);
          if (url) put("![" + (opts.alt || "图片") + "](" + url + ")", imgAt, imgEnd);
        } catch (err) {
          if (opts.onError) opts.onError(err);
        } finally {
          setBusy(false);
          ta.focus();
        }
      });
      bar.appendChild(file);
    }

    items.forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "md-btn";
      b.textContent = item.label;
      b.title = item.title;
      b.addEventListener("click", () => { if (!busy) item.run(); });
      bar.appendChild(b);
    });

    ta.dataset.mdBar = "1";
    ta.parentNode.insertBefore(bar, ta);
    return bar;
  }

  return { mount: mount };
})();

/* ============================================================
   开屏公告:每次更新都在这里填一次
   ------------------------------------------------------------
   约定(每次改代码都要做):
   1) 把本次更新的要点写进 SPLASH_NOTES
   2) 把 SPLASH_VERSION 改成一个新值(用日期就行) —— 版本号一变,
      所有设备(包括之前看过的)都会重新弹一次,知道有新东西
   3) 每台设备对同一个版本只弹一次,靠 localStorage 记住
   ============================================================ */

const SPLASH_VERSION = "2026-10-04-19";
const SPLASH_DATE = "2026.10.04";
const SPLASH_TITLE = "103 纪事 · 本次更新";
const SPLASH_LEAD = "图库上传终于通了：修好 KV 存储写入的类型问题。";
const SPLASH_NOTES = [
  "定位到真因：上传时把图片直接交给 KV 存会报类型错误，改成先转成二进制再存，已修好",
  "上传带真实进度条，超时给友好中文提示",
  "实名 30MB 额度、自己删自己的图、管理员/服主无限额度，规则不变",
];
const SPLASH_KEY = "class103-splash-" + SPLASH_VERSION;

function showSplash() {
  try {
    if (localStorage.getItem(SPLASH_KEY)) return;
    localStorage.setItem(SPLASH_KEY, "1");
  } catch (e) {
    /* 隐私模式下每次都弹,也没什么大不了 */
  }

  const wrap = document.createElement("div");
  wrap.className = "splash";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.innerHTML = `
    <div class="splash-card">
      <p class="splash-no">${SPLASH_DATE}</p>
      <h2 class="splash-title">${SPLASH_TITLE}</h2>
      <p class="splash-lead">${SPLASH_LEAD}</p>
      <ul class="splash-list">
        ${SPLASH_NOTES.map((t) => `<li>${t}</li>`).join("")}
      </ul>
      <div class="splash-foot">
        <a class="splash-btn ghost" href="announcements.html">看公告</a>
        <button class="splash-btn" type="button" id="splash-ok">开始逛逛</button>
      </div>
    </div>`;

  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("in"));

  const close = () => {
    wrap.classList.remove("in");
    setTimeout(() => wrap.remove(), 320);
  };
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  document.getElementById("splash-ok").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // 当前页面文件名,用于高亮
  const current = location.pathname.split("/").pop() || "index.html";

  // ---- 注入动态氛围柔光层:五团色斑缓慢漂移 ----
  // 玻璃卡背后的"磨砂"全靠它:没有东西可糊,backdrop-filter 就只剩一块半透明色。
  // 放在所有内容之前,由 base.css 的 .frost-layer 固定到视口背后(z-index:-1)。
  const frost = document.createElement("div");
  frost.className = "frost-layer";
  frost.setAttribute("aria-hidden", "true");
  frost.innerHTML = ["b1", "b2", "b3", "b4", "b5"]
    .map((c) => `<span class="frost-blob ${c}"></span>`)
    .join("");
  document.body.prepend(frost);

  // ---- 注入导航栏 ----
  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="container nav">
      <a class="nav-logo" href="index.html" data-nav>
        <img src="assets/images/logo.svg" alt="103班 Logo">
        <span><b>103 · 音乐领军班</b><small>Musical Vanguards</small></span>
      </a>
      <nav id="nav-links" class="nav-links">
        ${NAV_ITEMS.map((n) => {
          // 「私信」那项自带一个未读小红点,别的项不用
          const dot = n.href === "messages.html" ? '<span class="nav-dm-dot" id="nav-dm-dot" hidden></span>' : "";
          return `<a href="${n.href}" data-nav ${n.href === current ? 'class="active"' : ""}>${n.label}${dot}</a>`;
        }).join("")}
      </nav>
      <div class="nav-tools">
        <button id="nav-bell" class="nav-bell" type="button" aria-label="消息通知" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 9a6 6 0 0 0-12 0c0 4.6-1.8 5.8-1.8 5.8h15.6S18 13.6 18 9Z"></path>
            <path d="M10.2 18.6a2 2 0 0 0 3.6 0"></path>
          </svg>
          <span class="bell-dot" id="bell-dot" hidden></span>
        </button>
        <a class="nav-admin" id="nav-admin" href="admin.html" data-nav hidden>管理后台</a>
        <a class="nav-account" id="nav-account" href="account.html" data-nav></a>
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="外观：深色 / 浅色与主题色" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8.6"></circle>
            <path d="M12 3.4v17.2a8.6 8.6 0 0 0 0-17.2Z" fill="currentColor" stroke="none" opacity=".55"></path>
          </svg>
        </button>
        <button id="nav-toggle" class="nav-toggle" aria-label="打开菜单" data-nav>
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>`;
  document.body.prepend(header);

  // 手机版导航栏塞不下这个按钮,把它挪进汉堡菜单里
  if (matchMedia("(max-width: 820px)").matches) {
    const adminLink = header.querySelector("#nav-admin");
    const links = header.querySelector("#nav-links");
    if (adminLink && links) links.appendChild(adminLink);
  }

  // ---- 灵动岛:滚下去之后,整条导航收成左边的一个小圆圈 ----
  //   收/放完全不碰几何:胶囊淡出上移、小圆淡入放大,只动 opacity 与 transform(合成属性)。
  //   上一版用 JS 弹簧逐帧写 max-width/height/padding,每一帧都要重排版,
  //   带 backdrop-filter 还要顺带重算背景模糊 —— 那才是掉到十几帧的根因。
  //   现在只在"状态真的变了"时切一个类名,剩下的交给 CSS 过渡。
  //   首页第一屏是视频,导航有另一套深色逻辑,这里刻意用 nav-scrolled 这个类名避开。
  (function () {
    const nav = header.querySelector(".nav");
    if (!nav) return;

    // 小圆:独立元素,绝对定位贴在导航左边缘,展开时隐身
    const orb = document.createElement("button");
    orb.type = "button";
    orb.className = "nav-orb";
    orb.setAttribute("aria-label", "展开导航");
    orb.innerHTML = '<img src="assets/images/logo.svg" alt="103班 Logo">';
    header.appendChild(orb);

    const poster = document.body.classList.contains("poster")
      ? document.getElementById("poster")
      : null;
    const THRESHOLD = 64;        // 普通页面:滚过 64px 就收起

    let scrolled = false, opened = false, posterH = 0;
    let lastScrolled = null, lastCollapsed = null;
    const isSmall = () => matchMedia("(max-width: 900px)").matches;

    // 首屏高度只在这里量一次,不在滚动回调里读(读 offsetHeight 会强制刷新布局)
    function measure() {
      posterH = poster ? poster.offsetHeight : 0;
    }

    function apply() {
      const y = window.pageYOffset || document.documentElement.scrollTop || 0;
      scrolled = posterH ? y > posterH - 80 : y > THRESHOLD;
      if (!scrolled) opened = false;                 // 回到顶部就复位,下次滚下来照常收
      const collapsed = scrolled && !opened && !isSmall();

      // 值没变就不碰 DOM:滚动时这个函数每帧都会跑,白写一次属性都是浪费
      if (scrolled !== lastScrolled) {
        lastScrolled = scrolled;
        header.classList.toggle("nav-scrolled", scrolled);
      }
      if (collapsed !== lastCollapsed) {
        lastCollapsed = collapsed;
        header.classList.toggle("nav-collapsed", collapsed);
        nav.title = collapsed ? "展开导航" : "";
      }
    }

    // 收起状态下点圆圈(或胶囊) = 就地展开;展开后点页面空白处收回
    const expand = (e) => {
      if (!header.classList.contains("nav-collapsed")) return;
      if (e) e.preventDefault();
      opened = true;
      apply();
    };
    nav.addEventListener("click", expand);
    orb.addEventListener("click", (e) => { e.stopPropagation(); expand(e); });
    document.addEventListener("click", (e) => {
      if (!opened || nav.contains(e.target) || orb.contains(e.target)) return;
      opened = false;
      apply();
    });

    let ticking = false;
    addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; apply(); });
    }, { passive: true });
    addEventListener("resize", () => { measure(); apply(); }, { passive: true });
    measure();
    apply();
  })();

  // ---- 注入底部信息栏(固定不随滚动消失) ----
  // 文案从站点内容里取,后台改一次全站跟着变;拿不到就用这份兜底
  const DEFAULT_FOOTER = ["青春交响，永不散场", "金华一中 103班", "班主任：盛老师", "鸣谢：小柏制作"];
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  document.body.appendChild(footer);
  const renderFooter = () => {
    const site = C103Content.get("site") || {};
    const items = Array.isArray(site.footerItems) && site.footerItems.length
      ? site.footerItems
      : DEFAULT_FOOTER;
    footer.innerHTML = items.map(esc).join("<i>/</i>");
  };
  renderFooter();
  C103Content.onChange(renderFooter);
  C103Content.load();

  // ---- 账号:先按未登录渲染,再问服务器要真实状态 ----
  renderAccount();
  C103Auth.refresh();

  // ---- 消息通知:导航栏的小铃铛 + 下拉面板 ----
  const bell = document.getElementById("nav-bell");
  const dot = document.getElementById("bell-dot");
  const dmDot = document.getElementById("nav-dm-dot");
  const panel = document.createElement("div");
  panel.id = "notif-panel";
  panel.className = "notif-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="notif-head"><b>消息</b><button type="button" class="notif-x" id="notif-close" aria-label="关闭">×</button></div>
    <div class="notif-list" id="notif-list"></div>`;
  document.body.appendChild(panel);
  const notifList = panel.querySelector("#notif-list");

  const NOTIF_TEXT = { reply: "回复了你", wall: "在你主页留了言", like: "赞了你的主页" };

  function fmtAgo(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
    if (d < 604800000) return Math.floor(d / 86400000) + " 天前";
    const x = new Date(ms);
    return x.getMonth() + 1 + " 月 " + x.getDate() + " 日";
  }

  // 点通知跳哪儿:回复直接深链到那条回复,留言深链到那条留言,点赞回我的主页
  function notifLink(n) {
    if (n.type === "wall") {
      return "u.html?id=" + (n.wall_id || 0) + (n.post_id ? "&p=" + n.post_id : "");
    }
    if (n.type === "like") return "u.html?id=" + ((C103Auth.user && C103Auth.user.id) || "");
    const p = n.post_id ? "?p=" + n.post_id + (n.reply_id ? "&r=" + n.reply_id : "") : "";
    return "story.html" + p;
  }

  function renderNotif(items) {
    if (!items.length) {
      notifList.innerHTML = '<p class="notif-empty">还没有新消息</p>';
      return;
    }
    notifList.innerHTML = items
      .map((n) => {
        const a = n.actor;
        const face =
          a && a.avatar
            ? `<img class="notif-face" src="${API}/img/${esc(a.avatar)}" alt="">`
            : `<span class="notif-face notif-letter">${esc(a ? C103Person.name(a).slice(0, 1) : "?")}</span>`;
        const who = a ? C103Person.html(a) : "有人";
        return `<a class="notif-item${n.read ? "" : " unread"}" href="${notifLink(n)}" data-nid="${n.id}">
          ${face}
          <span class="notif-body">
            <span class="notif-t"><b>${who}</b> ${NOTIF_TEXT[n.type] || "有新动静"}</span>
            ${n.excerpt ? `<span class="notif-quote">${esc(n.excerpt)}</span>` : ""}
            <span class="notif-time">${fmtAgo(n.created_at)}</span>
          </span>
        </a>`;
      })
      .join("");
  }

  function setDot(n) {
    if (!dot) return;
    if (n > 0) {
      dot.hidden = false;
      dot.textContent = n > 99 ? "99+" : String(n);
    } else dot.hidden = true;
  }

  // 「私信」旁边的小红点:只做一个纯红点,不写数字,低调一点
  function setDmDot(n) {
    if (dmDot) dmDot.hidden = !(n > 0);
  }

  async function loadNotif() {
    if (!C103Auth.user) {
      if (bell) bell.hidden = true;
      setDot(0);
      setDmDot(0);
      return;
    }
    if (bell) bell.hidden = false;
    try {
      const d = await apiFetch(API + "/notifications");
      setDot(d.unread || 0);
      setDmDot(d.dmUnread || 0);
      renderNotif(d.items || []);
    } catch (e) {
      /* 通知拉不到不影响任何事 */
    }
  }

  function closeNotif() {
    panel.classList.remove("in");
    setTimeout(() => {
      panel.hidden = true;
    }, 220);
  }

  async function openNotif() {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("in"));
    // 打开就算读过了,红点立刻清掉
    if (dot && !dot.hidden) {
      setDot(0);
      notifList.querySelectorAll(".notif-item.unread").forEach((el) => el.classList.remove("unread"));
      try {
        await apiFetch(API + "/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: true }),
        });
      } catch (e) {
        /* 没标上也无所谓 */
      }
    }
  }

  if (bell) {
    bell.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.hidden) openNotif();
      else closeNotif();
    });
    panel.querySelector("#notif-close").addEventListener("click", closeNotif);
    document.addEventListener("click", (e) => {
      if (panel.hidden) return;
      if (panel.contains(e.target) || e.target === bell || bell.contains(e.target)) return;
      closeNotif();
    });
  }
  // 登录状态一变就重新拉一遍(没登录会自动把铃铛藏起来)
  C103Auth.onChange(() => loadNotif());

  // ---- 开屏公告 ----
  showSplash();

  // ---- 外观面板:深色 / 浅色 + 四套主题色 ----
  const themeBtn = document.getElementById("theme-toggle");
  const appear = document.createElement("div");
  appear.id = "appear-pop";
  appear.className = "appear-pop";
  appear.hidden = true;
  appear.setAttribute("role", "dialog");
  appear.setAttribute("aria-label", "外观设置");
  appear.innerHTML = `
    <p class="ap-title">外观模式</p>
    <div class="ap-row" id="ap-themes">
      <button type="button" class="ap-opt" data-theme-opt="dark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"></path>
        </svg><span>深色</span>
      </button>
      <button type="button" class="ap-opt" data-theme-opt="light">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2"></circle>
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"></path>
        </svg><span>浅色</span>
      </button>
    </div>
    <p class="ap-sub">主题色</p>
    <div class="ap-skins" id="ap-skins">${SKINS.map(
      (s) => `<button type="button" class="ap-skin" data-skin-opt="${s.id}" title="${s.name}">
        <span class="ap-dots"><i style="background:${s.dots[0]}"></i><i style="background:${s.dots[1]}"></i></span>
        <span class="ap-skin-name">${s.name}</span>
      </button>`
    ).join("")}</div>
    <p class="ap-hint">主题色只换点缀与氛围柔光，版式不变</p>`;
  document.body.appendChild(appear);

  const syncAppear = () => {
    const t = readTheme();
    appear.querySelectorAll("[data-theme-opt]").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeOpt === t);
    });
    const sk = readSkin();
    appear.querySelectorAll("[data-skin-opt]").forEach((b) => {
      b.classList.toggle("active", b.dataset.skinOpt === sk);
    });
    themeBtn.setAttribute("aria-expanded", appear.hidden ? "false" : "true");
  };

  const closeAppear = () => {
    appear.classList.remove("in");
    themeBtn.setAttribute("aria-expanded", "false");
    setTimeout(() => { appear.hidden = true; }, 200);
  };
  const openAppear = () => {
    syncAppear();
    appear.hidden = false;
    themeBtn.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => appear.classList.add("in"));
  };

  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (appear.hidden) openAppear();
    else closeAppear();
  });

  appear.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.addEventListener("click", () => { applyTheme(b.dataset.themeOpt); syncAppear(); });
  });
  appear.querySelectorAll("[data-skin-opt]").forEach((b) => {
    b.addEventListener("click", () => { applySkin(b.dataset.skinOpt); syncAppear(); });
  });
  document.addEventListener("click", (e) => {
    if (appear.hidden) return;
    if (appear.contains(e.target) || e.target === themeBtn || themeBtn.contains(e.target)) return;
    closeAppear();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !appear.hidden) closeAppear();
  });

  // ---- 手机汉堡菜单开合 ----
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle.classList.toggle("open");
    links.classList.toggle("open");
  });

  // 点击导航链接后自动收起菜单
  document.querySelectorAll("#nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      toggle.classList.remove("open");
      links.classList.remove("open");
    });
  });
});
