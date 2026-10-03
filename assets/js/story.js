/* ============================================================
   103 纪事 · 前端脚本
   1) 登录后才能发言:未登录显示登录入口,登录后直接用自己的账号署名
   2) 回复参考 B 站:点「回复」就地展开一个小输入框,不再滚回顶部
      —— 所有回复都平铺一层,靠「回复 @某某」说明关系
   3) 图片上传前用 canvas 压到 1MB 以内
   4) 每条都显示头像、身份徽章和 IP 属地;服主/管理员可置顶
   5) 删除:本人删自己的,服主/管理员删任意一条(不再需要删帖口令)

   同一份脚本同时给 story.html 和首页板块用:
   首页在引入本文件之前先设 window.CLASS103_BOARD = { limit: 3, compact: true },
   紧凑模式下只显示前 N 条主帖、不显示翻页。
   ============================================================ */

(function () {
  "use strict";

  const API = "api";                 // 相对路径:官网根目录、子目录都能用
  const MAX_IMAGES = 3;
  const COMPACT_REPLIES = 5;         // 首页紧凑模式:一条主帖最多先展开 5 条回复

  const CFG = Object.assign({ limit: 0, compact: false }, window.CLASS103_BOARD || {});

  const $ = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => {
    if (el) el.addEventListener(ev, fn);
  };

  const state = { page: 1, totalPages: 1, images: [], busy: false, user: null, openReply: 0 };
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
    const ch = author ? String(author.name).slice(0, 1) : "匿";
    return `<span class="story-avatar story-avatar-fallback">${esc(ch)}</span>`;
  }

  function badgeHTML(author) {
    const role = author && author.role;
    if (role === "owner") return '<em class="role-badge owner">服主</em>';
    if (role === "admin") return '<em class="role-badge admin">管理员</em>';
    return "";
  }

  function metaHTML(p) {
    const region = p.region ? ` · IP 属地：${esc(p.region)}` : "";
    return `${fmtTime(p.created_at)}${region}`;
  }

  function headHTML(p) {
    return `<div class="story-head">
      ${avatarHTML(p.author)}
      <div class="story-who">
        <span class="story-name">${esc(p.name)}${badgeHTML(p.author)}</span>
        <span class="story-meta">${metaHTML(p)}</span>
      </div>
    </div>`;
  }

  function bodyHTML(p) {
    const body = p.body ? `<p class="story-body">${esc(p.body)}</p>` : "";
    const imgs = p.images.length
      ? `<div class="story-imgs">${p.images
          .map((k) => `<img src="${API}/img/${k}" alt="纪事配图" loading="lazy">`)
          .join("")}</div>`
      : "";
    return body + imgs;
  }

  function actionsHTML(p) {
    const mine = !!(p.author && state.user && p.author.id === state.user.id);
    const canDel = mine || isStaff();
    let pin = "";
    if (isStaff() && !p.parent_id) {
      pin = `<button class="story-pin-btn" type="button" data-pin="${p.id}" data-on="${p.pinned ? 1 : 0}">${p.pinned ? "取消置顶" : "置顶"}</button>`;
    }
    const del = canDel ? `<button class="story-del" type="button" data-del="${p.id}">删除</button>` : "";
    return `<div class="story-actions">
      <button class="story-reply" type="button" data-reply="${p.id}" data-name="${esc(p.name)}">回复</button>
      ${pin}${del}
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

    return `<article class="story-card${p.pinned ? " is-pinned" : ""}" data-id="${p.id}">
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
      ? `<p class="story-to">回复 <b>@${esc(p.reply_to_name)}</b></p>`
      : "";
    return `<article class="story-card story-sub" data-id="${p.id}">
      ${headHTML(p)}
      ${to}
      ${bodyHTML(p)}
      ${actionsHTML({ ...p, parent_id: 1 })}
      <div class="reply-slot" data-slot="${p.id}"></div>
    </article>`;
  }

  function renderPager(total) {
    if (!els.pager) return;
    const show = !CFG.compact && total > 0 && state.totalPages > 1;
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

    if (els.meName) els.meName.innerHTML = esc(state.user.name) + badgeHTML(state.user);
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
    notice("读取中", "<br>正在翻开 103 的纪事…");
    if (els.pager) els.pager.hidden = true;
    try {
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
        body: JSON.stringify({ body: body, images: keys }),
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

    on(els.form, "submit", onSubmit);
    on(els.pickBtn, "click", () => els.file && els.file.click());
    on(els.file, "change", onPick);
    on(els.prev, "click", () => goto(state.page - 1));
    on(els.next, "click", () => goto(state.page + 1));

    on(els.list, "click", (e) => {
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
          '<div class="notice"><b>要用官网打开</b>这一页需要联网才能写。请访问 jinzhong2903.pages.dev 再试。</div>';
      }
      return;
    }

    // 等 nav.js 问完服务器「我是谁」再决定发帖框的样子
    const ready = (window.C103Auth && window.C103Auth.ready) || Promise.resolve(null);
    ready.then((user) => {
      state.user = user;
      renderComposer();
      if (window.C103Auth) {
        window.C103Auth.onChange((u) => {
          state.user = u;
          renderComposer();
        });
      }
      goto(1);
    });
  });
})();
