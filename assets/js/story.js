/* ============================================================
   103 纪事 · 前端脚本
   1) 登录后才能发言:未登录显示登录入口,登录后直接用自己的账号署名
   2) 回复参考 B 站:点「回复」就地展开一个小输入框,不再滚回顶部
      —— 所有回复都平铺一层,靠「回复 @某某」说明关系
   3) 图片上传前用 canvas 压到 1MB 以内
   4) 每条都显示头像、身份徽章和 IP 属地;服主/管理员可置顶
   5) 删除:本人删自己的,服主/管理员删任意一条(不再需要删帖口令)

   同一份脚本给四处地方用,靠 window.CLASS103_BOARD 里的 mode 区分:
     - mode: "list"   (默认) 103 纪事页:整篇铺开的列表,带回复树
     - mode: "cards"  首页:小红书式双列卡片流,帖子 + 视频混在一起,按时间倒序
     - mode: "videos" 视频页(videos.html):只要视频的双列卡片流
     - mode: "single" 帖子详情页(post.html):一条主帖 + 全部评论
   ============================================================ */

(function () {
  "use strict";

  const API = "api";                 // 相对路径:官网根目录、子目录都能用
  const MAX_IMAGES = 3;
  const COMPACT_REPLIES = 5;         // 首页紧凑模式:一条主帖最多先展开 5 条回复

  const CFG = Object.assign({ limit: 0, compact: false, mode: "list" }, window.CLASS103_BOARD || {});
  const MODES = ["cards", "videos", "single"];
  const MODE = MODES.indexOf(CFG.mode) >= 0 ? CFG.mode : "list";

  const $ = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => {
    if (el) el.addEventListener(ev, fn);
  };

  const state = {
    page: 1, totalPages: 1, images: [], busy: false, user: null, openReply: 0, visibility: "public", liking: 0,
    items: [],        // 首页那一页的合并流(帖子 + 视频),切换筛子时在本地过滤
    filter: "all",    // all / post / video
  };
  const els = {};
  // 每个内联回复框自己的待传图片:form 元素 → [ {blob,url} ]
  const replyImages = new Map();

  /* ---------- 小工具 ---------- */

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function isStaff() {
    return !!state.user && (state.user.role === "owner" || state.user.role === "admin");
  }

  function setMsg(text, kind) {
    if (!els.msg) return;
    els.msg.textContent = text || "";
    els.msg.className = "form-msg" + (kind ? " " + kind : "");
  }

  // 一句轻提示:飘在下方,两秒后自己消失
  function toast(text) {
    const t = document.createElement("div");
    t.className = "story-toast";
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => {
      t.classList.remove("in");
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }

  /* ---------- 图片压缩:交给 nav.js 里的公共实现,见 C103Image ---------- */

  function compressImage(file) {
    return window.C103Image.compress(file);
  }

  /* ---------- 接口 ---------- */

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "网络不太顺，稍后再试");
    return data;
  }

  function uploadImage(blob) {
    return api(API + "/upload", {
      method: "POST",
      headers: { "content-type": blob.type || "image/jpeg" },
      body: blob,
    }).then((d) => d.key);
  }

  async function uploadAll(list, onProgress) {
    const keys = [];
    for (let i = 0; i < list.length; i++) {
      if (onProgress) onProgress(`正在上传图片 ${i + 1} / ${list.length}…`);
      keys.push(await uploadImage(list[i].blob));
    }
    return keys;
  }

  /* ---------- 渲染 ---------- */

  function notice(title, text) {
    if (!els.list) return;
    els.list.innerHTML = `<div class="notice"><b>${title}</b>${text || ""}</div>`;
  }

  function avatarHTML(author) {
    if (author && author.avatar) {
      return `<img class="story-avatar" src="${API}/img/${esc(author.avatar)}" alt="" loading="lazy">`;
    }
    const ch = author ? String(C103Person.name(author)).slice(0, 1) : "匿";
    return `<span class="story-avatar story-avatar-fallback">${esc(ch)}</span>`;
  }

  function badgeHTML(author) {
    const role = author && author.role;
    if (role === "owner") return '<em class="role-badge owner">服主</em>';
    if (role === "admin") return '<em class="role-badge admin">管理员</em>';
    return "";
  }

  /* 正文渲染:交给 C103Emoji 转义,顺便把 [emoji:名字] 换成表情图。
     nav.js 没加载出来就退回普通转义,不至于白屏 */
  function richText(s) {
    return window.C103Emoji ? window.C103Emoji.render(s) : esc(s);
  }

  /* 摘要 / 标题里的纯文本版:占位符换成 :名字: */
  function plainText(s) {
    return window.C103Emoji ? window.C103Emoji.plain(s) : String(s == null ? "" : s);
  }

  /* 渲染前先把表情列表拿到手,否则正文里的自制表情会显示成 [emoji:xx] */
  function emojiReady() {
    if (!window.C103Emoji) return Promise.resolve();
    return window.C103Emoji.load().catch(() => {});
  }

  // 头像外面套一层,好在右下角挂「在线」小绿点。
  // author.online 只有卡片流 / 详情接口才给,列表页拿不到就不显示点
  function faceHTML(author, cls) {
    const dot = author && author.online ? '<i class="on-dot" title="在线"></i>' : "";
    return `<span class="face-wrap${cls ? " " + cls : ""}">${avatarHTML(author)}${dot}</span>`;
  }

  function metaHTML(p) {
    const region = p.region ? ` · IP 属地：${esc(p.region)}` : "";
    return `${fmtTime(p.created_at)}${region}`;
  }

  function headHTML(p) {
    // 有账号的作者:头像和名字都能点进 TA 的个人主页;早期匿名老帖保持不可点
    const uid = p.author && p.author.id;
    const href = uid ? `u.html?id=${uid}` : "";
    const face = faceHTML(p.author);
    // 「仅本班」的帖子挂个小标签,让发的人自己看得出这条只有登录的人能看
    const vis = p.visibility === "class" ? '<em class="vis-badge">仅本班</em>' : "";
    // 名字统一走 C103Person:能看真名就显示真名 + 蓝钩,否则显示账号名
    const name = `<span class="story-name">${C103Person.html(p.author, p.name)}${vis}${badgeHTML(p.author)}</span>`;
    return `<div class="story-head">
      ${href ? `<a class="story-face-link" href="${href}">${face}</a>` : face}
      <div class="story-who">
        ${href ? `<a class="story-name-link" href="${href}">${name}</a>` : name}
        <span class="story-meta">${metaHTML(p)}</span>
      </div>
    </div>`;
  }

  function bodyHTML(p) {
    const body = p.body ? `<p class="story-body">${richText(p.body)}</p>` : "";
    const imgs = p.images.length
      ? `<div class="story-imgs">${p.images
          .map((k) => `<img src="${API}/img/${k}" alt="纪事配图" loading="lazy">`)
          .join("")}</div>`
      : "";
    return body + imgs;
  }

  function actionsHTML(p) {
    const mine = !!(p.author && state.user && p.author.id === state.user.id);
    const canManage = mine || isStaff();
    let pin = "";
    if (isStaff() && !p.parent_id) {
      pin = `<button class="story-pin-btn" type="button" data-pin="${p.id}" data-on="${p.pinned ? 1 : 0}">${p.pinned ? "取消置顶" : "置顶"}</button>`;
    }
    const edit = canManage ? `<button class="story-edit" type="button" data-edit="${p.id}">编辑</button>` : "";
    const del = canManage ? `<button class="story-del" type="button" data-del="${p.id}">删除</button>` : "";
    // 点赞只给主帖,而且只在接口带了 likes 的时候才长出来
    // (列表页不查点赞,就别凭空多一个永远是 0 的按钮)
    const like =
      !p.parent_id && p.likes !== undefined
        ? `<button class="like-pill${p.liked ? " on" : ""}" type="button" data-like="${p.id}" data-on="${p.liked ? 1 : 0}" aria-label="点赞"><i>${p.liked ? "♥" : "♡"}</i><span>${p.likes}</span></button>`
        : "";
    return `<div class="story-actions">
      ${like}
      <button class="story-reply" type="button" data-reply="${p.id}" data-name="${esc(C103Person.name(p.author, p.name))}">回复</button>
      ${edit}${pin}${del}
    </div>`;
  }

  // 主帖:带头像、置顶标记、动作条,下面平铺所有回复
  function rootHTML(p) {
    const kids = p.replies || [];
    const shown = CFG.compact ? kids.slice(0, COMPACT_REPLIES) : kids;
    const rest = kids.length - shown.length;

    let replies = "";
    if (shown.length || rest > 0) {
      const inner = shown.map((r) => subHTML(r)).join("");
      const more = rest > 0
        ? `<a class="story-more" href="story.html">还有 ${rest} 条回复，去 103 纪事看 →</a>`
        : "";
      replies = `<div class="story-replies">${inner}${more}</div>`;
    }

    return `<article class="story-card${p.pinned ? " is-pinned" : ""}" data-id="${p.id}" id="p${p.id}">
      ${p.pinned ? '<span class="story-pin">置顶</span>' : ""}
      ${headHTML(p)}
      ${bodyHTML(p)}
      ${actionsHTML({ ...p, parent_id: null })}
      <div class="reply-slot" data-slot="${p.id}"></div>
      ${replies}
    </article>`;
  }

  // 回复:平铺一层,不再缩进;用「回复 @某某」标出对象
  function subHTML(p) {
    const to = p.reply_to_name
      ? `<p class="story-to">回复 <b>@${esc(p.reply_to_name)}${p.reply_to_verified ? window.C103Person.check : ""}</b></p>`
      : "";
    return `<article class="story-card story-sub" data-id="${p.id}" id="r${p.id}">
      ${headHTML(p)}
      ${to}
      ${bodyHTML(p)}
      ${actionsHTML({ ...p, parent_id: 1 })}
      <div class="reply-slot" data-slot="${p.id}"></div>
    </article>`;
  }

  /* ---------- 小红书式卡片(首页) ---------- */

  // 卡片上放不下整篇正文,取正文压成一行当「标题」;纯图片帖给个占位说法
  function titleOf(p) {
    const t = plainText(p.body || "").replace(/\s+/g, " ").trim();
    return t || "图片";
  }

  function cardHTML(p) {
    const imgs = p.images || [];
    const cover = imgs.length
      ? `<div class="card-cover">
          <img src="${API}/img/${esc(imgs[0])}" alt="" loading="lazy">
          ${imgs.length > 1 ? `<span class="card-count">${imgs.length} 图</span>` : ""}
        </div>`
      : `<div class="card-cover card-noimg"><span>${esc(titleOf(p))}</span></div>`;

    return `<article class="story-card xhs-card${p.pinned ? " is-pinned" : ""}" data-id="${p.id}">
      <a class="card-link" href="post.html?id=${p.id}" data-veil aria-label="打开这一条"></a>
      ${p.pinned ? '<span class="story-pin">置顶</span>' : ""}
      ${cover}
      <div class="card-info">
        <p class="card-title">${esc(titleOf(p))}</p>
        <div class="card-foot">
          <span class="card-author">${faceHTML(p.author)}${authorNameHTML(p.author, p.name)}</span>
          <button class="like-pill${p.liked ? " on" : ""}" type="button" data-like="${p.id}" data-on="${p.liked ? 1 : 0}" aria-label="点赞"><i>${p.liked ? "♥" : "♡"}</i><span>${p.likes || 0}</span></button>
        </div>
      </div>
    </article>`;
  }

  /* 卡片上那行发帖人:头像 + 名字(带身份徽章 / 认证药丸) */
  function authorNameHTML(author, fallback) {
    return `<span class="story-name card-author-name">${C103Person.html(
      author,
      fallback
    )}${badgeHTML(author)}</span>`;
  }

  /* 时长:mm:ss。没有时长(老浏览器录不出来)就不显示 */
  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return "";
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  /* 视频卡片:和帖子卡片长得一样,只是封面中间多一枚播放键、右上角显示时长。
     点进去是全屏播放页 video.html,不是帖子详情页 */
  function videoCardHTML(v) {
    if (!v) return "";
    const cover = v.cover
      ? `<img src="${API}/img/${esc(v.cover)}" alt="" loading="lazy">`
      : "";
    const dur = fmtDur(v.duration);
    return `<article class="story-card xhs-card v-card" data-id="${v.id}">
      <a class="card-link" href="video.html?id=${v.id}" aria-label="打开这个视频"></a>
      <div class="card-cover v-cover">
        ${cover}
        <span class="v-play" aria-hidden="true"></span>
        ${dur ? `<span class="card-count">${dur}</span>` : ""}
        <button class="card-del" type="button" data-vdel="${v.id}" hidden aria-label="删除这条视频">×</button>
      </div>
      <div class="card-info">
        <p class="card-title">${esc(v.title || "视频")}</p>
        <div class="card-foot">
          <span class="card-author">${faceHTML(v.author)}${authorNameHTML(v.author)}</span>
          <button class="like-pill${v.liked ? " on" : ""}" type="button" data-vlike="${v.id}" data-on="${v.liked ? 1 : 0}" aria-label="点赞"><i>${v.liked ? "♥" : "♡"}</i><span>${v.likes || 0}</span></button>
        </div>
      </div>
    </article>`;
  }

  /* ---------- 首页混排:图文和视频同一条流,顶上一排筛子 ---------- */

  function cardOf(it) {
    if (!it) return "";
    return it.type === "video" ? videoCardHTML(it.video) : cardHTML(it.post);
  }

  // 只在本地过滤,不再为切筛子多跑一趟接口
  function renderCards() {
    if (!els.list) return;
    const all = state.items || [];
    const list = state.filter === "all" ? all : all.filter((it) => it.type === state.filter);
    if (!list.length) {
      els.list.innerHTML = `<div class="notice"><b>这类还没有</b>换个筛子看看，或者你去发第一条。</div>`;
      return;
    }
    els.list.innerHTML = list.map(cardOf).join("");
    paintCardDel();
  }

  /* 「删视频」只给视频本人和服主 / 管理员。后端才是真正把关的那道,
     前端只是按身份把叉号亮出来 */
  function canDelVideo(v) {
    if (!state.user || !v) return false;
    if (state.user.role === "owner" || state.user.role === "admin") return true;
    return !!(v.author && v.author.id === state.user.id);
  }

  function paintCardDel() {
    if (!els.list) return;
    els.list.querySelectorAll(".v-card").forEach((card) => {
      const id = parseInt(card.getAttribute("data-id"), 10) || 0;
      const hit = (state.items || []).filter((x) => x.type === "video" && x.video && x.video.id === id)[0];
      const btn = card.querySelector("[data-vdel]");
      if (btn) btn.hidden = !canDelVideo(hit && hit.video);
    });
  }

  async function delVideoCard(id) {
    const hit = (state.items || []).filter((x) => x.type === "video" && x.video && x.video.id === id)[0];
    const v = hit && hit.video;
    if (!v) return;
    const title = String(v.title || "这条视频").slice(0, 20);
    if (!confirm(`删除「${title}」？\n下面的评论、点赞、收藏会一起删掉，删了找不回来。`)) return;
    try {
      await api(API + "/videos/" + id, { method: "DELETE" });
    } catch (err) {
      toast(err.message);
      return;
    }
    // 卡片就地抽掉,不整页重跑
    const card = els.list.querySelector(`.v-card[data-id="${id}"]`);
    if (card) card.remove();
    const i = state.items.indexOf(hit);
    if (i >= 0) state.items.splice(i, 1);
    toast("删掉了");
  }

  function renderPager(total) {
    if (!els.pager) return;
    // 只要有人写过就把分页条亮出来(和隔壁一样「第 1 / 1 页」),
    // 不再是「超过一页才出现」,这样人少时也看得出这里是分页的
    const show = !CFG.compact && total > 0;
    els.pager.hidden = !show;
    if (els.pageInfo) els.pageInfo.textContent = `第 ${state.page} / ${state.totalPages} 页`;
    if (els.prev) els.prev.disabled = state.page <= 1;
    if (els.next) els.next.disabled = state.page >= state.totalPages;
  }

  /* ---------- 发帖框:登录了才给用 ---------- */

  function renderComposer() {
    const gate = $("#login-gate");
    const logged = !!state.user;

    if (els.form) els.form.hidden = !logged;
    if (gate) gate.hidden = logged;
    if (!logged) return;

    if (els.meName) els.meName.innerHTML = C103Person.html(state.user) + badgeHTML(state.user);
    if (els.meAvatar) els.meAvatar.innerHTML = avatarHTML(state.user);
    if (els.meSig) els.meSig.textContent = state.user.signature || "还没写个性签名";
    syncPick();
  }

  function syncPick() {
    if (!els.pickBtn || !els.pickHint) return;
    const full = state.images.length >= MAX_IMAGES;
    els.pickBtn.disabled = state.busy || full;
    if (els.file) els.file.disabled = state.busy || full;
    els.pickHint.textContent = full
      ? `已选满 ${MAX_IMAGES} 张`
      : `最多 ${MAX_IMAGES} 张，上传前自动压到 1MB 以内`;
  }

  /* ---------- 内联回复框(B 站那种:点一下就在这条下面展开) ---------- */

  function closeReply() {
    if (!state.openReply) return;
    const slot = document.querySelector(`.reply-slot[data-slot="${state.openReply}"]`);
    if (slot) slot.innerHTML = "";
    const card = document.querySelector(`.story-card[data-id="${state.openReply}"]`);
    if (card) card.classList.remove("is-replying");
    state.openReply = 0;
  }

  function openReplyBox(card, id, name) {
    if (state.openReply === id) {
      closeReply();
      return;
    }
    closeReply();

    const slot = card.querySelector(".reply-slot");
    if (!slot) return;

    slot.innerHTML = `<form class="inline-reply" autocomplete="off">
      <p class="inline-to">回复 <b>@${esc(name)}</b><button type="button" class="inline-x" aria-label="收起">×</button></p>
      <textarea rows="2" maxlength="4000" placeholder="回复 @${esc(name)}…"></textarea>
      <div class="inline-row">
        <input type="file" accept="image/*" multiple hidden>
        <button type="button" class="pick-btn sm">＋ 加图</button>
        <button type="button" class="emoji-btn" title="插入表情">😊</button>
        <div class="thumbs sm"></div>
      </div>
      <div class="inline-foot">
        <p class="form-msg"></p>
        <button class="submit-btn sm" type="submit">回复</button>
      </div>
    </form>`;

    const form = slot.querySelector("form");
    replyImages.set(form, []);
    card.classList.add("is-replying");
    state.openReply = id;

    const file = form.querySelector('input[type="file"]');
    const pick = form.querySelector(".pick-btn");
    const thumbs = form.querySelector(".thumbs");
    const msg = form.querySelector(".form-msg");

    // 回复框也能插表情:把「😊」接到这个 textarea 上
    if (window.C103Emoji) {
      window.C103Emoji.mount(form.querySelector(".emoji-btn"), form.querySelector("textarea"));
    }

    const say = (text, kind) => {
      msg.textContent = text || "";
      msg.className = "form-msg" + (kind ? " " + kind : "");
    };
    const sync = () => {
      const list = replyImages.get(form) || [];
      const full = list.length >= MAX_IMAGES;
      pick.disabled = full;
      file.disabled = full;
    };

    on(pick, "click", () => file.click());
    on(file, "change", async () => {
      const files = Array.from(file.files || []);
      file.value = "";
      for (const f of files) {
        const list = replyImages.get(form) || [];
        if (list.length >= MAX_IMAGES) {
          say(`最多只能放 ${MAX_IMAGES} 张图`, "err");
          break;
        }
        if (!/^image\//.test(f.type)) {
          say("只能选图片文件", "err");
          continue;
        }
        const box = document.createElement("div");
        box.className = "thumb busy";
        thumbs.appendChild(box);
        sync();
        try {
          const blob = await compressImage(f);
          const url = URL.createObjectURL(blob);
          const entry = { blob, url };
          list.push(entry);
          replyImages.set(form, list);
          box.classList.remove("busy");
          box.innerHTML = `<img src="${url}" alt=""><button type="button" aria-label="移除">×</button>`;
          box.querySelector("button").addEventListener("click", () => {
            const cur = replyImages.get(form) || [];
            const i = cur.indexOf(entry);
            if (i >= 0) cur.splice(i, 1);
            URL.revokeObjectURL(url);
            box.remove();
            say("");
            sync();
          });
          say("");
        } catch (err) {
          box.remove();
          say(err.message, "err");
        }
        sync();
      }
    });

    on(form.querySelector(".inline-x"), "click", closeReply);

    on(form, "submit", async (e) => {
      e.preventDefault();
      const area = form.querySelector("textarea");
      const body = area.value.trim();
      const list = replyImages.get(form) || [];
      if (!body && list.length === 0) {
        say("回复总得写点什么吧", "err");
        return;
      }
      const btn = form.querySelector(".submit-btn");
      btn.disabled = true;
      btn.textContent = "发送中";
      try {
        const keys = await uploadAll(list, say);
        await api(API + "/posts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: body, images: keys, reply_to_id: id }),
        });
        list.forEach((it) => URL.revokeObjectURL(it.url));
        replyImages.delete(form);
        state.openReply = 0;
        await goto(state.page);
        const back = document.querySelector(`.story-card[data-id="${id}"]`);
        if (back) back.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "回复";
        say(err.message, "err");
        if (/登录/.test(err.message)) {
          state.user = null;
          renderComposer();
        }
      }
    });

    area.focus();
  }

  /* ---------- 加载列表 ---------- */

  async function goto(page) {
    if (page < 1) return;
    if (MODE === "single") return loadPost();
    await emojiReady();
    notice("读取中", "<br>正在翻开 103 的纪事…");
    if (els.pager) els.pager.hidden = true;
    try {
      // 视频页:只铺视频卡片
      if (MODE === "videos") {
        const data = await api(API + "/videos?page=" + page);
        state.page = data.page;
        state.totalPages = Math.max(1, Math.ceil(data.total / data.size));
        // 存成和首页同一套形状,删卡片时好按 id 找回来
        state.items = (data.items || []).map((v) => ({ type: "video", video: v }));
        if (!data.total) {
          notice("还没有人发视频", "<br>第一个片子，等你来拍。");
        } else if (els.list) {
          els.list.innerHTML = state.items.map(cardOf).join("");
          paintCardDel();
        }
        renderPager(data.total);
        return;
      }

      // 首页:帖子和视频混在一条流里(小红书那种),后端已经合好并排好序
      if (MODE === "cards") {
        const data = await api(API + "/feed?page=" + page);
        state.page = data.page;
        state.totalPages = Math.max(1, Math.ceil(data.total / data.size));
        state.items = data.items || [];
        if (!data.total) {
          notice("还没有人写下第一句", "<br>第一行字，等你来落笔。");
        } else {
          renderCards();
        }
        renderPager(data.total);
        return;
      }

      const data = await api(API + "/posts?page=" + page);
      state.page = data.page;
      state.totalPages = Math.max(1, Math.ceil(data.total / data.size));
      let posts = data.posts || [];
      if (CFG.limit > 0) posts = posts.slice(0, CFG.limit);

      if (!data.total) {
        notice("还没有人写下第一句", "<br>第一行字，等你来落笔。");
      } else if (els.list) {
        els.list.innerHTML = posts.map(rootHTML).join("");
      }
      renderPager(data.total);
    } catch (err) {
      if (els.list) {
        els.list.innerHTML = `<div class="notice"><b>「103 纪事」正在开通中</b>${esc(
          err.message
        )}<br>稍后再来看看。</div>`;
      }
      if (els.pager) els.pager.hidden = true;
    }
  }

  /* ---------- 帖子详情页(post.html) ----------
     卡片点进来看到的那一页:正文、全部图片、全部评论。
     ?id= 是要看的主帖;?r= 是「从通知点进来的那一条回复」,渲染完滚过去描个金边 */
  async function loadPost() {
    const q = new URLSearchParams(location.search);
    const id = parseInt(q.get("id") || "0", 10) || 0;
    const rid = parseInt(q.get("r") || "0", 10) || 0;

    if (!id) {
      notice("没有指定要看哪一条", '<br><a class="post-back" href="index.html">← 回首页</a>');
      return;
    }

    await emojiReady();
    notice("读取中", "<br>正在打开这一条…");
    try {
      const data = await api(API + "/posts/" + id);
      const post = data.post;
      if (els.list) {
        els.list.innerHTML = `<div class="post-detail">
          <a class="post-back" href="index.html">← 回首页</a>
          ${rootHTML(post)}
        </div>`;
      }
      if (els.pager) els.pager.hidden = true;

      if (rid) {
        const target = document.getElementById("r" + rid);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("is-focused");
          setTimeout(() => target.classList.remove("is-focused"), 3000);
        }
      }
    } catch (err) {
      notice(
        "这一条打不开了",
        esc(err.message) + '<br><a class="post-back" href="index.html">← 回首页</a>'
      );
    }
  }

  /* ---------- 点赞(先本地翻面,服务器回来再对账) ---------- */

  function paintLike(btn, on_, n) {
    btn.classList.toggle("on", !!on_);
    btn.setAttribute("data-on", on_ ? "1" : "0");
    const icon = btn.querySelector("i");
    const num = btn.querySelector("span");
    if (icon) icon.textContent = on_ ? "♥" : "♡";
    if (num) num.textContent = String(n);
  }

  async function onLike(btn, kind) {
    if (!state.user) {
      toast("登录后才能点赞");
      return;
    }
    const video = kind === "video";
    const id = parseInt(btn.getAttribute(video ? "data-vlike" : "data-like"), 10) || 0;
    const key = (video ? "v" : "p") + id;
    if (!id || state.liking === key) return;

    const wasOn = btn.getAttribute("data-on") === "1";
    const nextOn = !wasOn;
    const num = btn.querySelector("span");
    const prev = parseInt((num && num.textContent) || "0", 10) || 0;

    state.liking = key;
    // 先自己翻面,手感立刻跟上;失败再翻回去
    paintLike(btn, nextOn, Math.max(0, prev + (nextOn ? 1 : -1)));
    btn.classList.add("bump");

    try {
      const d = await api(API + (video ? "/videos/" : "/posts/") + id + "/like", { method: "POST" });
      paintLike(btn, !!d.liked, d.likes);
    } catch (err) {
      paintLike(btn, wasOn, prev);
      toast(err.message);
      if (/登录/.test(err.message)) {
        state.user = null;
        renderComposer();
      }
    } finally {
      state.liking = 0;
      setTimeout(() => btn.classList.remove("bump"), 420);
    }
  }

  /* ---------- 通知深链:?p=根帖 & r=回复 ----------
     点铃铛里的「回复了你」进来时会带上这两个参数。
     先问后端这条在第几页,翻过去之后再滚到它身上、描金闪一下。 */
  async function focusDeepLink() {
    if (CFG.compact || MODE !== "list") return false;   // 卡片流 / 详情页不参与
    const q = new URLSearchParams(location.search);
    const p = parseInt(q.get("p") || "0", 10) || 0;
    const r = parseInt(q.get("r") || "0", 10) || 0;
    if (!p && !r) return false;

    let page = 1;
    let rootId = p || r;
    try {
      const d = await api(API + "/posts?find=" + (r || p));
      // 这条其实是视频下面的评论,留言板里根本没有它,直接转去播放页
      if (d.kind === "video" && d.video_id) {
        location.href = "video.html?id=" + d.video_id + (r ? "&r=" + r : "");
        return true;
      }
      page = d.page || 1;
      rootId = d.root_id || rootId;
    } catch (err) {
      /* 定位不上就老老实实从第一页看起 */
    }

    await goto(page);
    const target = document.getElementById(r ? "r" + r : "p" + rootId);
    if (!target) return true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-focused");
    setTimeout(() => target.classList.remove("is-focused"), 3000);
    return true;
  }

  /* ---------- 顶部发帖框:选图 ---------- */

  async function onPick() {
    const files = Array.from(els.file.files || []);
    els.file.value = "";

    for (const file of files) {
      if (state.images.length >= MAX_IMAGES) {
        setMsg(`最多只能放 ${MAX_IMAGES} 张图`, "err");
        break;
      }
      if (!/^image\//.test(file.type)) {
        setMsg("只能选图片文件", "err");
        continue;
      }

      const slot = document.createElement("div");
      slot.className = "thumb busy";
      els.thumbs.appendChild(slot);
      syncPick();
      setMsg(`正在压缩 ${file.name}…`);

      try {
        const blob = await compressImage(file);
        const url = URL.createObjectURL(blob);
        const entry = { blob, url };
        state.images.push(entry);

        slot.classList.remove("busy");
        slot.innerHTML = `<img src="${url}" alt=""><button type="button" aria-label="移除">×</button>`;
        slot.querySelector("button").addEventListener("click", () => {
          const i = state.images.indexOf(entry);
          if (i >= 0) state.images.splice(i, 1);
          URL.revokeObjectURL(url);
          slot.remove();
          syncPick();
          setMsg("");
        });
        setMsg(`已压到 ${(blob.size / 1024 / 1024).toFixed(2)} MB`, "ok");
      } catch (err) {
        slot.remove();
        setMsg(err.message, "err");
      }
    }
    syncPick();
  }

  /* ---------- 发一条新帖 ---------- */

  async function onSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    if (!state.user) {
      toast("登录后才能发言");
      return;
    }

    const body = els.body.value.trim();
    if (!body && state.images.length === 0) {
      setMsg("写点什么，或者加张图吧", "err");
      return;
    }

    state.busy = true;
    els.submit.disabled = true;
    els.submit.textContent = "发布中";
    syncPick();

    try {
      const keys = await uploadAll(state.images, setMsg);
      setMsg("正在发布…");
      await api(API + "/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: body, images: keys, visibility: state.visibility }),
      });

      state.images.forEach((it) => URL.revokeObjectURL(it.url));
      state.images = [];
      els.thumbs.innerHTML = "";
      els.body.value = "";
      setMsg("发布好了，谢谢你的记录", "ok");
      await goto(1);
    } catch (err) {
      setMsg(err.message, "err");
      if (/登录/.test(err.message)) {
        state.user = null;
        renderComposer();
      }
    } finally {
      state.busy = false;
      els.submit.disabled = false;
      els.submit.textContent = "发布";
      syncPick();
    }
  }

  /* ---------- 删除 / 置顶 ---------- */

  async function onDelete(id) {
    if (!confirm("确定删掉这条？它下面的回复和图片会一起删掉，删了就找不回来了。")) return;
    try {
      await api(API + "/posts/" + id, { method: "DELETE" });
      state.openReply = 0;
      // 详情页的那条被删了就没什么可看的了,直接回首页
      if (MODE === "single") {
        location.href = "index.html";
        return;
      }
      await goto(state.page);
    } catch (err) {
      toast(err.message);
    }
  }

  async function onPin(id, on_) {
    try {
      await api(API + "/posts/" + id, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !on_ }),
      });
      await goto(state.page);
    } catch (err) {
      toast(err.message);
    }
  }

  /* ---------- 编辑正文 ---------- */

  async function onEdit(id) {
    const card = document.querySelector(`.story-card[data-id="${id}"]`);
    if (!card) return;
    const bodyEl = card.querySelector(":scope > .story-body");
    const current = bodyEl ? bodyEl.textContent : "";
    const next = prompt("改这条留言的正文：", current);
    if (next === null) return;                 // 点了取消
    const body = next.trim();
    if (!body || body === current) return;     // 空内容或没改动,不折腾

    try {
      await api(API + "/posts/" + id, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: body }),
      });
      // 只改这一处文本,不整页刷新;用 textContent 而不是 innerHTML,免得有人把标签写进来
      if (bodyEl) bodyEl.textContent = body;
      else await goto(state.page); // 原来只有图没字,得重画一次才会出现正文
      toast("改好了");
    } catch (err) {
      toast(err.message);
    }
  }

  /* ---------- 启动 ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    els.form = $("#composer");
    els.body = $("#f-body");
    els.file = $("#f-file");
    els.pickBtn = $("#pick-btn");
    els.pickHint = $("#pick-hint");
    els.thumbs = $("#thumbs");
    els.msg = $("#form-msg");
    els.submit = $("#submit-btn");
    els.list = $("#story-list");
    els.pager = $("#pager");
    els.pageInfo = $("#page-info");
    els.prev = $("#prev-btn");
    els.next = $("#next-btn");
    els.lightbox = $("#lightbox");
    els.lightboxImg = $("#lightbox-img");
    els.meName = $("#me-name");
    els.meAvatar = $("#me-avatar");
    els.meSig = $("#me-sig");
    els.visPick = $("#vis-pick");
    els.tabs = $("#feed-tabs");

    // 首页那排筛子:图文 / 视频混在一起,想单看一类就在本地过一下
    if (els.tabs && MODE === "cards") {
      els.tabs.hidden = false;
      els.tabs.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-feed]");
        if (!btn) return;
        state.filter = btn.getAttribute("data-feed") || "all";
        els.tabs
          .querySelectorAll("[data-feed]")
          .forEach((b) => b.classList.toggle("active", b === btn));
        renderCards();
      });
    }

    on(els.form, "submit", onSubmit);
    on(els.pickBtn, "click", () => els.file && els.file.click());
    on(els.file, "change", onPick);
    // 表情按钮插在「＋ 加图片」旁边,点了往正文里插
    if (window.C103Emoji && els.pickBtn && els.body) {
      const eb = document.createElement("button");
      eb.type = "button";
      eb.className = "emoji-btn";
      eb.title = "插入表情";
      eb.textContent = "😊";
      els.pickBtn.parentNode.insertBefore(eb, els.pickBtn.nextSibling);
      window.C103Emoji.mount(eb, els.body);
    }
    // 可见性切换:全部可见 / 仅本班可见(登录的人才能发,所以不担心游客乱选)
    on(els.visPick, "click", (e) => {
      const opt = e.target.closest("[data-vis]");
      if (!opt) return;
      state.visibility = opt.getAttribute("data-vis") === "class" ? "class" : "public";
      els.visPick
        .querySelectorAll("[data-vis]")
        .forEach((b) => b.classList.toggle("active", b === opt));
    });
    on(els.prev, "click", () => goto(state.page - 1));
    on(els.next, "click", () => goto(state.page + 1));

    on(els.list, "click", (e) => {
      // 卡片角上的叉号:压在整卡链接之上,先拦下来免得跳进播放页
      const vdel = e.target.closest("[data-vdel]");
      if (vdel) {
        e.preventDefault();
        e.stopPropagation();
        delVideoCard(parseInt(vdel.getAttribute("data-vdel"), 10) || 0);
        return;
      }
      // 点赞最优先:卡片里的按钮压在整卡链接之上,但保险起见还是先拦一下
      const vlike = e.target.closest("[data-vlike]");
      if (vlike) {
        e.preventDefault();
        e.stopPropagation();
        onLike(vlike, "video");
        return;
      }
      const like = e.target.closest("[data-like]");
      if (like) {
        e.preventDefault();
        e.stopPropagation();
        onLike(like, "post");
        return;
      }
      const rep = e.target.closest("[data-reply]");
      if (rep) {
        if (!state.user) {
          toast("登录后才能回复");
          const gate = $("#login-gate");
          if (gate) gate.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        const card = rep.closest(".story-card");
        if (card) openReplyBox(card, rep.getAttribute("data-reply"), rep.getAttribute("data-name") || "同学");
        return;
      }
      const pin = e.target.closest("[data-pin]");
      if (pin) {
        onPin(pin.getAttribute("data-pin"), pin.getAttribute("data-on") === "1");
        return;
      }
      const edit = e.target.closest("[data-edit]");
      if (edit) {
        onEdit(edit.getAttribute("data-edit"));
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        onDelete(del.getAttribute("data-del"));
        return;
      }
      if (e.target.tagName === "IMG" && e.target.closest(".story-imgs")) {
        if (!els.lightbox) return;
        els.lightboxImg.src = e.target.src;
        els.lightbox.classList.add("open");
      }
    });

    on(els.lightbox, "click", () => {
      els.lightbox.classList.remove("open");
      els.lightboxImg.src = "";
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (els.lightbox) els.lightbox.classList.remove("open");
      closeReply();
    });

    // 本地双击打开时没有后端,直接给一句人话,别一直转圈
    if (location.protocol === "file:") {
      if (els.form) els.form.hidden = true;
      if (els.list) {
        els.list.innerHTML =
          '<div class="notice"><b>要用官网打开</b>这一页需要联网才能写。请访问 jinzhong2903.me 再试。</div>';
      }
      return;
    }

    // 等 nav.js 问完服务器「我是谁」再决定发帖框的样子
    const ready = (window.C103Auth && window.C103Auth.ready) || Promise.resolve(null);
    ready.then((user) => {
      state.user = user;
      renderComposer();
      paintCardDel();
      if (window.C103Auth) {
        window.C103Auth.onChange((u) => {
          state.user = u;
          renderComposer();
          paintCardDel();
        });
      }
      // 带 ?p= / ?r= 就是从通知点进来的,直接翻到那一条;否则从第一页看起
      focusDeepLink().then((hit) => {
        if (!hit) goto(1);
      });

      // 从底部那个「＋」跳过来的:等发帖框亮出来,直接送到位并聚焦
      if (new URLSearchParams(location.search).get("post")) {
        const jump = () => {
          if (!els.form || els.form.hidden) return false;
          els.form.scrollIntoView({ behavior: "smooth", block: "center" });
          if (els.body) els.body.focus();
          return true;
        };
        if (!jump()) {
          let n = 0;
          const t = setInterval(() => {
            if (jump() || ++n > 20) clearInterval(t);
          }, 200);
        }
      }
    });
  });
})();
