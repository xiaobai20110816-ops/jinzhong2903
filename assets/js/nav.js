/* ============================================================
   103班：音乐领军班 · 全站公共脚本
   1) 动态注入导航栏 + 主题开关 + 底部信息栏
   2) 账号系统:window.C103Auth(登录 / 注册 / 退出 / 改资料)
   3) 10.3 开屏弹窗:官网正式成立(每台设备只弹一次)
   所有页面共用这一份,子页面不用各自写导航和登录逻辑。
   ============================================================ */

// 导航配置：改了导航项,所有页面一起变
const NAV_ITEMS = [
  { href: "index.html", label: "首页" },
  { href: "students.html", label: "学生风采" },
  { href: "dormitory.html", label: "宿舍风采" },
  { href: "moments.html", label: "高光时刻" },
  { href: "story.html", label: "103 纪事" },
  { href: "announcements.html", label: "班级公告" },
];

// 主题存在 localStorage:dark(默认) / light
const THEME_KEY = "class103-theme";
const THEME_COLORS = { dark: "#070b14", light: "#f4f6fa" };

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
   图片压缩:留言配图和头像共用同一套逻辑
   长边压到 1600 以内,质量从 0.85 逐档降到 0.45,还超标就缩尺寸,
   一直到 ≤1MB —— 手机上直出的几 MB 照片也能顺利上传
   ============================================================ */

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function decodeImage(file) {
  // createImageBitmap 能顺手按 EXIF 方向摆正,iPhone 竖拍的照片不会躺倒
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      /* 个别浏览器不认这个选项,退回 <img> */
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
      src = await decodeImage(file);
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
  btn.title = u.name + (ROLE_LABEL[u.role] ? "（" + ROLE_LABEL[u.role] + "）" : "");
  const face = u.avatar
    ? `<img class="acc-avatar" src="${API}/img/${esc(u.avatar)}" alt="">`
    : `<span class="acc-avatar acc-letter">${esc(u.name.slice(0, 1))}</span>`;
  btn.innerHTML = face + '<span class="acc-text">' + esc(u.name) + "</span>";
}

/* ============================================================
   10.3 开屏弹窗:官网正式成立
   每台设备只弹一次(记住之后就不再打扰)
   ============================================================ */

const SPLASH_KEY = "class103-splash-2026-10-03";

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
      <p class="splash-no">2026.10.03</p>
      <h2 class="splash-title">103 官网正式成立</h2>
      <p class="splash-lead">金秋十月，属于我们的数字阵地正式上线。</p>
      <ul class="splash-list">
        <li>自由注册登录 —— 起个名字、传头像、写个性签名</li>
        <li>留言板升级 —— 像 B 站一样逐条回复，每条都标注 IP 属地</li>
        <li>服主标识 —— 班委账号带金色「服主」徽章，发言自动置顶</li>
        <li>图片上传 —— 最多 3 张，自动压缩，传得快也看得清</li>
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
        ${NAV_ITEMS.map(
          (n) => `<a href="${n.href}" data-nav ${n.href === current ? 'class="active"' : ""}>${n.label}</a>`
        ).join("")}
      </nav>
      <a class="nav-admin" id="nav-admin" href="admin.html" data-nav hidden>管理后台</a>
      <a class="nav-account" id="nav-account" href="account.html" data-nav></a>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="切换深色 / 浅色模式">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2"></circle>
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"></path>
        </svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"></path>
        </svg>
      </button>
      <button id="nav-toggle" class="nav-toggle" aria-label="打开菜单" data-nav>
        <span></span><span></span><span></span>
      </button>
    </div>`;
  document.body.prepend(header);

  // 手机版导航栏塞不下这个按钮,把它挪进汉堡菜单里
  if (matchMedia("(max-width: 820px)").matches) {
    const adminLink = header.querySelector("#nav-admin");
    const links = header.querySelector("#nav-links");
    if (adminLink && links) links.appendChild(adminLink);
  }

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

  // ---- 10.3 开屏弹窗 ----
  showSplash();

  // ---- 主题开关 ----
  const themeBtn = document.getElementById("theme-toggle");
  themeBtn.addEventListener("click", () => {
    applyTheme(readTheme() === "light" ? "dark" : "light");
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
