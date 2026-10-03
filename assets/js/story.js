/* ============================================================
   103 纪事 · 前端脚本
   1) 发帖:纯文字 + 最多 3 张图
   2) 图片在上传前用 canvas 压到 1MB 以内
   3) 倒序列表 + 翻页
   4) 无限层嵌套回复(缩进最多到第 4 层,更深的靠「回复 @某某」辨认)
   5) 凭口令删掉自己发的帖子

   同一份脚本同时给 story.html 和首页板块用:
   首页在引入本文件之前先设 window.CLASS103_BOARD = { limit: 3, compact: true },
   紧凑模式下只显示前 N 条主帖、不显示翻页。
   ============================================================ */

(function () {
  "use strict";

  const API = "api";                 // 相对路径:官网根目录、子目录都能用
  const MAX_IMAGES = 3;
  const MAX_EDGE = 1600;             // 长边像素上限
  const TARGET_BYTES = 1024 * 1024;  // 压到 1MB 以内
  const INDENT_MAX = 4;              // 缩进最多 4 层,再深就不缩了
  const COMPACT_REPLIES = 5;         // 首页紧凑模式:一条主帖最多先展开 5 条回复

  const CFG = Object.assign({ limit: 0, compact: false }, window.CLASS103_BOARD || {});

  const $ = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => {
    if (el) el.addEventListener(ev, fn);
  };

  const state = { page: 1, totalPages: 1, images: [], busy: false, locked: false, replyTo: null };
  const els = {};

  /* ---------- 小工具 ---------- */

  // 同一台设备一个随机 id,只用来做「别发太快」的限流(整个班共用校园网时不会互相卡住)
  function cid() {
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

  function setMsg(text, kind) {
    if (!els.msg) return;
    els.msg.textContent = text || "";
    els.msg.className = "form-msg" + (kind ? " " + kind : "");
  }

  function submitLabel() {
    return state.replyTo ? "回复" : "发布";
  }

  /* ---------- 图片压缩:长边 ≤1600,质量从 0.85 逐档降到 0.45,
       还超标就缩尺寸再来一轮,直到 ≤1MB ---------- */

  function toBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  async function decode(file) {
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

  async function compressImage(file) {
    let src;
    try {
      src = await decode(file);
    } catch (e) {
      throw new Error("这张图浏览器读不出来（iPhone 的 HEIC 格式最常见），请在相册里先导出成 JPG 再传。");
    }

    const w0 = src.width || 1;
    const h0 = src.height || 1;
    const fit = Math.min(1, MAX_EDGE / Math.max(w0, h0));
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
      if (blob && blob.size <= TARGET_BYTES) break;

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
    if (blob.size > file.size && file.size <= TARGET_BYTES) return file;
    return blob;
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

  /* ---------- 渲染 ---------- */

  function notice(title, text) {
    if (!els.list) return;
    els.list.innerHTML = `<div class="notice"><b>${title}</b>${text || ""}</div>`;
  }

  // depth:当前这条在第几层(0 = 主帖);parentName:它回复的是谁
  function cardHTML(p, depth, parentName) {
    depth = depth || 0;

    const to = parentName ? `<p class="story-to">回复 <b>@${esc(parentName)}</b></p>` : "";
    const body = p.body ? `<p class="story-body">${esc(p.body)}</p>` : "";
    const imgs = p.images.length
      ? `<div class="story-imgs">${p.images
          .map((k) => `<img src="${API}/img/${k}" alt="纪事配图" loading="lazy">`)
          .join("")}</div>`
      : "";

    // 子回复:首页紧凑模式下一条主帖最多先展开 5 条,其余给个入口去纪事页看
    const kids = p.replies || [];
    const shown = CFG.compact ? kids.slice(0, COMPACT_REPLIES) : kids;
    const rest = kids.length - shown.length;
    let replies = "";
    if (shown.length || rest > 0) {
      const inner = shown.map((r) => cardHTML(r, depth + 1, p.name)).join("");
      const more = rest > 0
        ? `<a class="story-more" href="story.html">还有 ${rest} 条回复，去 103 纪事看 →</a>`
        : "";
      const flat = depth + 1 > INDENT_MAX ? " no-indent" : "";
      replies = `<div class="story-replies${flat}">${inner}${more}</div>`;
    }

    return `<article class="story-card" data-id="${p.id}">
      ${to}
      <div class="story-head">
        <span class="story-name">${esc(p.name)}</span>
        <span class="story-time">${fmtTime(p.created_at)}</span>
      </div>
      ${body}${imgs}
      <div class="story-actions">
        <button class="story-reply" type="button" data-reply="${p.id}" data-name="${esc(p.name)}">回复</button>
        <button class="story-del" type="button" data-del="${p.id}">删除</button>
      </div>
      ${replies}
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

  function lockForm(locked) {
    state.locked = locked;
    ["name", "pass", "body", "pickBtn", "submit"].forEach((k) => {
      if (els[k]) els[k].disabled = locked;
    });
    if (!locked) syncPick();
  }

  function syncPick() {
    if (!els.pickBtn || !els.pickHint) return;
    const full = state.images.length >= MAX_IMAGES;
    els.pickBtn.disabled = state.locked || full;
    if (els.file) els.file.disabled = state.locked || full;
    els.pickHint.textContent = full
      ? `已选满 ${MAX_IMAGES} 张`
      : `最多 ${MAX_IMAGES} 张，上传前自动压到 1MB 以内`;
  }

  /* ---------- 正在回复谁 ---------- */

  function setReplyTo(id, name) {
    state.replyTo = id ? { id, name } : null;

    if (els.replyChip) {
      if (state.replyTo) {
        els.replyChipText.innerHTML = `正在回复 <b>@${esc(name)}</b>`;
        els.replyChip.hidden = false;
      } else {
        els.replyChip.hidden = true;
      }
    }
    if (els.body) {
      els.body.placeholder = state.replyTo
        ? `回复 @${name}…`
        : els.bodyHome || "那天发生了什么？写下来，就是 103 的历史。";
    }
    if (els.submit && !state.busy) els.submit.textContent = submitLabel();

    // 把被回复那张卡描个金边,方便对上号
    if (!els.list) return;
    els.list.querySelectorAll(".story-card.is-replying").forEach((c) => c.classList.remove("is-replying"));
    if (state.replyTo) {
      const card = els.list.querySelector(`.story-card[data-id="${id}"]`);
      if (card) card.classList.add("is-replying");
    }
  }

  function startReply(id, name) {
    setReplyTo(id, name);
    if (!els.form) return;
    els.form.scrollIntoView({ behavior: "smooth", block: "center" });
    if (els.body) els.body.focus();
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
        els.list.innerHTML = posts.map((p) => cardHTML(p, 0, "")).join("");
      }
      renderPager(data.total);
      lockForm(false);
    } catch (err) {
      lockForm(true);
      if (els.list) {
        els.list.innerHTML = `<div class="notice"><b>「103 纪事」正在开通中</b>${esc(
          err.message
        )}<br>稍后再来看看。</div>`;
      }
      if (els.pager) els.pager.hidden = true;
    }
  }

  /* ---------- 选图 ---------- */

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

  /* ---------- 发帖 / 回复 ---------- */

  async function onSubmit(e) {
    e.preventDefault();
    if (state.busy || state.locked) return;

    const body = els.body.value.trim();
    const password = els.pass.value.trim();
    const replyTo = state.replyTo;

    if (!body && state.images.length === 0) {
      setMsg(replyTo ? "回复总得写点什么吧" : "写点什么，或者加张图吧", "err");
      return;
    }
    if (password.length < 4) {
      setMsg("删帖口令请设 4 位以上，自己记住", "err");
      return;
    }

    state.busy = true;
    els.submit.disabled = true;
    els.submit.textContent = replyTo ? "回复中" : "发布中";

    try {
      const keys = [];
      for (let i = 0; i < state.images.length; i++) {
        setMsg(`正在上传图片 ${i + 1} / ${state.images.length}…`);
        keys.push(await uploadImage(state.images[i].blob));
      }

      setMsg("正在发布…");
      await api(API + "/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: els.name.value.trim(),
          body: body,
          password: password,
          images: keys,
          cid: cid(),
          parent_id: replyTo ? replyTo.id : 0,
        }),
      });

      try {
        localStorage.setItem("class103-name", els.name.value.trim());
      } catch (err) {
        /* 隐私模式下忽略 */
      }

      state.images.forEach((it) => URL.revokeObjectURL(it.url));
      state.images = [];
      els.thumbs.innerHTML = "";
      els.body.value = "";
      els.pass.value = "";
      syncPick();
      setMsg(replyTo ? "回复好了" : "发布好了，谢谢你的记录", "ok");
      if (replyTo) setReplyTo(null);
      await goto(1);
      if (replyTo && els.list) {
        const card = els.list.querySelector(`.story-card[data-id="${replyTo.id}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (err) {
      setMsg(err.message, "err");
    } finally {
      state.busy = false;
      els.submit.disabled = false;
      els.submit.textContent = submitLabel();
    }
  }

  /* ---------- 删帖 ---------- */

  async function onDelete(id) {
    const password = prompt("删除这条纪事，请输入发帖时设的口令：");
    if (!password) return;
    try {
      await api(API + "/posts/" + id, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: password }),
      });
      // 被删的那条可能正是当前在回复的对象,清掉免得发出去时报"那条已经不在了"
      setReplyTo(null);
      await goto(state.page);
    } catch (err) {
      alert(err.message);
    }
  }

  /* ---------- 启动 ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    els.form = $("#composer");
    els.name = $("#f-name");
    els.pass = $("#f-pass");
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
    els.replyChip = $("#reply-chip");
    els.replyChipText = $("#reply-chip-text");

    if (els.body) els.bodyHome = els.body.placeholder;

    try {
      if (els.name) els.name.value = localStorage.getItem("class103-name") || "";
    } catch (e) {
      /* 隐私模式下忽略 */
    }

    on(els.form, "submit", onSubmit);
    on(els.pickBtn, "click", () => els.file && els.file.click());
    on(els.file, "change", onPick);
    on(els.prev, "click", () => goto(state.page - 1));
    on(els.next, "click", () => goto(state.page + 1));
    on($("#reply-chip-x"), "click", () => setReplyTo(null));

    on(els.list, "click", (e) => {
      const rep = e.target.closest("[data-reply]");
      if (rep) {
        startReply(rep.getAttribute("data-reply"), rep.getAttribute("data-name") || "同学");
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
      if (state.replyTo) setReplyTo(null);
    });

    // 本地双击打开时没有后端,直接给一句人话,别一直转圈
    if (location.protocol === "file:") {
      lockForm(true);
      if (els.list) {
        els.list.innerHTML =
          '<div class="notice"><b>要用官网打开</b>这一页需要联网才能写。请访问 jinzhong2903.ccwu.cc 再试。</div>';
      }
      return;
    }

    goto(1);
  });
})();
