/* ============================================================
   103 纪事 · 前端脚本
   1) 发帖:纯文字 + 最多 3 张图
   2) 图片在上传前用 canvas 压到 1MB 以内
   3) 倒序列表 + 翻页
   4) 凭口令删掉自己发的帖子
   ============================================================ */

(function () {
  "use strict";

  const API = "api";                 // 相对路径:官网根目录、子目录都能用
  const MAX_IMAGES = 3;
  const MAX_EDGE = 1600;             // 长边像素上限
  const TARGET_BYTES = 1024 * 1024;  // 压到 1MB 以内

  const $ = (sel) => document.querySelector(sel);

  const state = { page: 1, totalPages: 1, images: [], busy: false, locked: false };
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
    els.msg.textContent = text || "";
    els.msg.className = "form-msg" + (kind ? " " + kind : "");
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
    els.list.innerHTML = `<div class="notice"><b>${title}</b>${text || ""}</div>`;
  }

  function cardHTML(p) {
    const body = p.body ? `<p class="story-body">${esc(p.body)}</p>` : "";
    const imgs = p.images.length
      ? `<div class="story-imgs">${p.images
          .map((k) => `<img src="${API}/img/${k}" alt="纪事配图" loading="lazy">`)
          .join("")}</div>`
      : "";
    return `<article class="story-card">
      <div class="story-head">
        <span class="story-name">${esc(p.name)}</span>
        <span class="story-time">${fmtTime(p.created_at)}</span>
      </div>
      ${body}${imgs}
      <div class="story-actions"><button class="story-del" type="button" data-del="${p.id}">删除</button></div>
    </article>`;
  }

  function renderPager(total) {
    const show = total > 0 && state.totalPages > 1;
    els.pager.hidden = !show;
    els.pageInfo.textContent = `第 ${state.page} / ${state.totalPages} 页`;
    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= state.totalPages;
  }

  function lockForm(locked) {
    state.locked = locked;
    ["name", "pass", "body", "pickBtn", "submit"].forEach((k) => {
      if (els[k]) els[k].disabled = locked;
    });
    if (!locked) syncPick();
  }

  function syncPick() {
    const full = state.images.length >= MAX_IMAGES;
    els.pickBtn.disabled = state.locked || full;
    els.file.disabled = state.locked || full;
    els.pickHint.textContent = full
      ? `已选满 ${MAX_IMAGES} 张`
      : `最多 ${MAX_IMAGES} 张，上传前自动压到 1MB 以内`;
  }

  /* ---------- 加载列表 ---------- */

  async function goto(page) {
    if (page < 1) return;
    notice("读取中", "<br>正在翻开 103 的纪事…");
    els.pager.hidden = true;
    try {
      const data = await api(API + "/posts?page=" + page);
      state.page = data.page;
      state.totalPages = Math.max(1, Math.ceil(data.total / data.size));
      if (!data.total) {
        notice("还没有人写下第一句", "<br>第一行字，等你来落笔。");
      } else {
        els.list.innerHTML = data.posts.map(cardHTML).join("");
      }
      renderPager(data.total);
      lockForm(false);
    } catch (err) {
      lockForm(true);
      els.list.innerHTML = `<div class="notice"><b>「103 纪事」正在开通中</b>${esc(
        err.message
      )}<br>稍后再来看看。</div>`;
      els.pager.hidden = true;
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

  /* ---------- 发帖 ---------- */

  async function onSubmit(e) {
    e.preventDefault();
    if (state.busy || state.locked) return;

    const body = els.body.value.trim();
    const password = els.pass.value.trim();

    if (!body && state.images.length === 0) {
      setMsg("写点什么，或者加张图吧", "err");
      return;
    }
    if (password.length < 4) {
      setMsg("删帖口令请设 4 位以上，自己记住", "err");
      return;
    }

    state.busy = true;
    els.submit.disabled = true;
    const label = els.submit.textContent;
    els.submit.textContent = "发布中";

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
      setMsg("发布好了，谢谢你的记录", "ok");
      await goto(1);
    } catch (err) {
      setMsg(err.message, "err");
    } finally {
      state.busy = false;
      els.submit.disabled = false;
      els.submit.textContent = label;
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

    try {
      els.name.value = localStorage.getItem("class103-name") || "";
    } catch (e) {
      /* 隐私模式下忽略 */
    }

    els.form.addEventListener("submit", onSubmit);
    els.pickBtn.addEventListener("click", () => els.file.click());
    els.file.addEventListener("change", onPick);
    els.prev.addEventListener("click", () => goto(state.page - 1));
    els.next.addEventListener("click", () => goto(state.page + 1));

    els.list.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        onDelete(del.getAttribute("data-del"));
        return;
      }
      if (e.target.tagName === "IMG" && e.target.closest(".story-imgs")) {
        els.lightboxImg.src = e.target.src;
        els.lightbox.classList.add("open");
      }
    });

    els.lightbox.addEventListener("click", () => {
      els.lightbox.classList.remove("open");
      els.lightboxImg.src = "";
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") els.lightbox.classList.remove("open");
    });

    // 本地双击打开时没有后端,直接给一句人话,别一直转圈
    if (location.protocol === "file:") {
      lockForm(true);
      els.list.innerHTML =
        '<div class="notice"><b>要用官网打开</b>这一页需要联网才能写。请访问 jinzhong2903.ccwu.cc 再试。</div>';
      return;
    }

    goto(1);
  });
})();
