/* ============================================================
   103 · 视频(上传面板 + 全屏播放页)

   两个挂载点,各自独立,不互相干扰:
   1) videos.html 上的 #video-upload → 发布视频(选片、自动截封面、带进度上传)
   2) video.html 上的 #player        → 全屏上下滑播放,右侧点赞 / 评论 / 收藏 / 分享

   视频文件全在 B2,库里只存 key;前端一律走 /api/videos/file/<key> 取流,
   不用关心它存在哪儿。卡片网格由 assets/js/story.js 的 mode:"videos" 负责,
   这里只管「上传」和「播放」。
   ============================================================ */

(function () {
  "use strict";

  const API = "api";
  const MAX_BYTES = 80 * 1024 * 1024;
  const PAGE_SIZE = 20;

  const $ = (sel) => document.querySelector(sel);

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return "";
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function avatarHTML(author) {
    if (author && author.avatar) {
      return `<img class="story-avatar" src="${API}/img/${esc(author.avatar)}" alt="" loading="lazy">`;
    }
    const ch = author ? String(C103Person.name(author)).slice(0, 1) : "已";
    return `<span class="story-avatar story-avatar-fallback">${esc(ch)}</span>`;
  }

  function badgeHTML(author) {
    const role = author && author.role;
    if (role === "owner") return '<em class="role-badge owner">服主</em>';
    if (role === "admin") return '<em class="role-badge admin">管理员</em>';
    return "";
  }

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

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "网络不太顺，稍后再试");
    return data;
  }

  function authReady() {
    return (window.C103Auth && window.C103Auth.ready) || Promise.resolve(null);
  }

  function isStaff(u) {
    return !!u && (u.role === "owner" || u.role === "admin");
  }

  /* ============================================================
     一、发布视频(videos.html)
     ============================================================ */

  /* 从视频里截一帧当封面,顺便把时长和分辨率读出来。
     手机拍的片子动辄几十兆,封面按长边 720 缩一下再上传就够了。 */
  function grabCover(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        fn(arg);
      };

      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.src = url;

      v.onloadedmetadata = () => {
        const dur = Number(v.duration) || 0;
        // 取 10% 处的画面(避开开头的黑场),最多 3 秒
        const t = Math.min(Math.max(0.1, dur * 0.1), 3);
        try {
          v.currentTime = t;
        } catch (e) {
          finish(reject, new Error("读不出画面，换个视频试试"));
        }
      };

      v.onseeked = () => {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) {
          finish(reject, new Error("读不出画面，换个视频试试"));
          return;
        }
        const scale = Math.min(1, 720 / Math.max(w, h));
        const cw = Math.round(w * scale);
        const chh = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = chh;
        canvas.getContext("2d").drawImage(v, 0, 0, cw, chh);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              finish(reject, new Error("封面生成失败，重新选一次"));
              return;
            }
            finish(resolve, {
              blob,
              width: w,
              height: h,
              duration: Number(v.duration) || 0,
            });
          },
          "image/jpeg",
          0.86
        );
      };

      v.onerror = () => finish(reject, new Error("这个视频浏览器打不开，换成 MP4 再试"));
    });
  }

  /* 带进度的上传:fetch 拿不到上传进度,XHR 才行 */
  function putVideo(file, query, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + "/videos/upload?" + query);
      xhr.setRequestHeader("content-type", file.type || "video/mp4");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let d = {};
        try {
          d = JSON.parse(xhr.responseText || "{}");
        } catch (e) {
          d = {};
        }
        if (xhr.status >= 200 && xhr.status < 300 && d.ok) resolve(d);
        else reject(new Error(d.error || "上传失败（HTTP " + xhr.status + "）"));
      };
      xhr.onerror = () => reject(new Error("网络断了，视频没传完，再试一次"));
      xhr.send(file);
    });
  }

  function mountUpload() {
    const box = $("#video-upload");
    if (!box) return;

    const drop = box.querySelector("#v-drop");
    const file = box.querySelector("#v-file");
    const preview = box.querySelector("#v-preview");
    const metaRow = box.querySelector("#v-meta-row");
    const titleEl = box.querySelector("#v-title");
    const bodyEl = box.querySelector("#v-body");
    const visPick = box.querySelector("#v-vis");
    const progress = box.querySelector("#v-progress");
    const bar = box.querySelector("#v-progress i");
    const msg = box.querySelector("#v-msg");
    const submit = box.querySelector("#v-submit");

    const state = { file: null, cover: null, duration: 0, width: 0, height: 0, busy: false };

    const say = (text, kind) => {
      msg.textContent = text || "";
      msg.className = "form-msg" + (kind ? " " + kind : "");
    };

    function reset() {
      state.file = null;
      state.cover = null;
      state.duration = 0;
      state.width = 0;
      state.height = 0;
      if (preview) {
        preview.hidden = true;
        preview.removeAttribute("src");
      }
      if (metaRow) metaRow.innerHTML = "";
      drop.hidden = false;
    }

    drop.addEventListener("click", () => file.click());

    file.addEventListener("change", async () => {
      const f = (file.files || [])[0];
      file.value = "";
      if (!f) return;

      reset();
      if (!/^video\//.test(f.type) && !/\.(mp4|webm|mov|m4v)$/i.test(f.name)) {
        say("只收 MP4 / WebM / MOV 视频", "err");
        return;
      }
      if (f.size > MAX_BYTES) {
        say("视频超过 " + Math.round(MAX_BYTES / 1048576) + "MB，先剪短或压一下再传", "err");
        return;
      }

      state.file = f;
      say("正在读这个视频…");
      if (preview) {
        preview.src = URL.createObjectURL(f);
        preview.hidden = false;
      }
      drop.hidden = true;

      try {
        const info = await grabCover(f);
        state.cover = info.blob;
        state.duration = info.duration;
        state.width = info.width;
        state.height = info.height;
        if (metaRow) {
          metaRow.innerHTML =
            `<span class="v-tag">${esc(f.name).slice(0, 26)}</span>` +
            `<span class="v-tag">${esc(fmtSize(f.size))}</span>` +
            (state.duration ? `<span class="v-tag">时长 ${esc(fmtDur(state.duration))}</span>` : "") +
            (state.width ? `<span class="v-tag">${state.width}×${state.height}</span>` : "") +
            `<span class="v-tag">封面已自动截好</span>`;
        }
        say("好了，起个标题就能发", "ok");
      } catch (err) {
        say(err.message, "err");
      }
    });

    // 谁可以看
    let visibility = "public";
    if (visPick) {
      visPick.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-vis]");
        if (!opt) return;
        visibility = opt.getAttribute("data-vis") === "class" ? "class" : "public";
        visPick.querySelectorAll("[data-vis]").forEach((b) => b.classList.toggle("active", b === opt));
      });
    }

    submit.addEventListener("click", async () => {
      if (state.busy) return;
      if (!state.file) {
        say("先选一个视频", "err");
        return;
      }
      const title = titleEl.value.trim();
      if (!title) {
        say("给这个视频起个标题吧", "err");
        titleEl.focus();
        return;
      }

      state.busy = true;
      submit.disabled = true;
      submit.textContent = "上传中";
      progress.hidden = false;
      bar.style.width = "0%";

      try {
        // 封面先走普通的图片上传(小图进 KV),再把 key 跟着视频一起提交
        let coverKey = "";
        if (state.cover) {
          say("正在上传封面…");
          const blob = await window.C103Image.compress(
            new File([state.cover], "cover.jpg", { type: "image/jpeg" })
          );
          const d = await api(API + "/upload", {
            method: "POST",
            headers: { "content-type": blob.type || "image/jpeg" },
            body: blob,
          });
          coverKey = d.key;
        }

        const q = new URLSearchParams({
          title,
          body: bodyEl.value.trim().slice(0, 2000),
          cover: coverKey,
          dur: String(Math.round(state.duration)),
          w: String(state.width),
          h: String(state.height),
          vis: visibility,
        });

        say("正在上传视频，别关页面…（0%）");
        await putVideo(state.file, q.toString(), (p) => {
          const pct = Math.round(p * 100);
          bar.style.width = pct + "%";
          say(`正在上传视频，别关页面…（${pct}%）`);
        });

        bar.style.width = "100%";
        say("发布好了，去视频页看看", "ok");
        titleEl.value = "";
        bodyEl.value = "";
        reset();
        progress.hidden = true;
        // 刷新一下卡片流:视频页由 story.js 负责,直接重载最省事也最不容易错
        setTimeout(() => location.reload(), 700);
      } catch (err) {
        say(err.message, "err");
      } finally {
        state.busy = false;
        submit.disabled = false;
        submit.textContent = "发布视频";
      }
    });

    // 登录了才有发视频的入口;没实名 / 不是管理就先藏起来
    authReady().then((user) => {
      if (!user || (!isStaff(user) && user.verified !== 1)) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
    });
  }

  /* ============================================================
     二、全屏播放页(video.html)
     ============================================================ */

  function mountPlayer() {
    const root = $("#player");
    if (!root) return;

    const q = new URLSearchParams(location.search);
    const startId = parseInt(q.get("id") || "0", 10) || 0;
    const focusRid = parseInt(q.get("r") || "0", 10) || 0;

    const scroll = root.querySelector("#player-scroll");
    const drawer = $("#v-drawer");
    const drawerList = drawer.querySelector("#v-drawer-list");
    const drawerCount = drawer.querySelector("#v-drawer-count");

    const state = {
      items: [],        // 已加载的视频
      page: 1,
      totalPages: 1,
      loading: false,
      me: null,
      current: null,    // 当前在播的那个视频
      replyTo: null,    // 正在回复的评论
      busy: false,
    };

    const byId = new Map();

    /* ---- 渲染 ---- */

    function slideHTML(v) {
      const cover = v.cover ? ` poster="${API}/img/${esc(v.cover)}"` : "";
      const uid = v.author && v.author.id;
      const face = uid ? `<a class="v-author" href="u.html?id=${uid}">` : `<span class="v-author">`;
      const faceEnd = uid ? "</a>" : "</span>";
      const name = v.author
        ? `<span class="v-author-name">${C103Person.html(v.author)}${badgeHTML(v.author)}</span>`
        : `<span class="v-author-name">已注销</span>`;

      return `<section class="player-slide" data-vid="${v.id}">
        <video src="${API}/videos/file/${esc(v.file)}"${cover} playsinline webkit-playsinline loop preload="metadata"></video>
        <span class="v-bar"><i></i></span>
        <span class="v-tapzoom"><i>❚❚</i></span>
        <div class="v-rail">
          <button class="v-act v-like${v.liked ? " on" : ""}" type="button" data-vlike="${v.id}" data-on="${v.liked ? 1 : 0}"><i>${v.liked ? "♥" : "♡"}</i><span>${v.likes || 0}</span></button>
          <button class="v-act v-cmt" type="button" data-comment="${v.id}"><i>💬</i><span>${v.comments || 0}</span></button>
          <button class="v-act v-fav${v.faved ? " on" : ""}" type="button" data-vfav="${v.id}" data-on="${v.faved ? 1 : 0}"><i>★</i><span>${v.favs || 0}</span></button>
          <button class="v-act v-share" type="button" data-share="${v.id}"><i>↗</i><span>分享</span></button>
        </div>
        <div class="v-meta">
          ${face}${avatarHTML(v.author)}${name}${faceEnd}
          <p class="v-title">${esc(v.title || "视频")}</p>
          ${v.body ? `<p class="v-body">${esc(v.body)}</p>` : ""}
          <p class="v-dateline">${esc(fmtTime(v.created_at))}</p>
        </div>
      </section>`;
    }

    function appendItems(items) {
      const html = items
        .filter((v) => v && v.file && !byId.has(v.id))
        .map((v) => {
          byId.set(v.id, v);
          state.items.push(v);
          return slideHTML(v);
        })
        .join("");
      if (html) scroll.insertAdjacentHTML("beforeend", html);
    }

    /* ---- 加载 ---- */

    async function load(page) {
      if (state.loading) return;
      if (page > state.totalPages && page !== 1) return;
      state.loading = true;
      try {
        const d = await api(API + "/videos?page=" + page + "&size=" + PAGE_SIZE);
        state.page = d.page;
        state.totalPages = Math.max(1, Math.ceil(d.total / d.size));
        appendItems(d.items || []);

        if (!state.items.length) {
          scroll.innerHTML = `<div class="player-empty"><b>还没有视频</b>第一个片子，等你来拍。<br><a href="videos.html">← 回视频页</a></div>`;
          return;
        }
        if (page === 1) {
          // 带 ?id= 进来的,直接滚到那一条;否则从最新的开始
          const target = startId && document.querySelector(`.player-slide[data-vid="${startId}"]`);
          if (target) target.scrollIntoView({ block: "start" });
          setActive();
        }
      } catch (err) {
        if (!state.items.length) {
          scroll.innerHTML = `<div class="player-empty"><b>打不开</b>${esc(err.message)}<br><a href="videos.html">← 回视频页</a></div>`;
        }
      } finally {
        state.loading = false;
      }
    }

    /* ---- 播放控制:只有「真正占满屏幕的那一屏」在放 ---- */

    function videos() {
      return Array.from(scroll.querySelectorAll(".player-slide"));
    }

    function setActive() {
      const viewH = scroll.clientHeight || 1;
      const mid = scroll.scrollTop + viewH / 2;
      let best = null;
      let bestDist = Infinity;
      for (const sl of videos()) {
        const center = sl.offsetTop + sl.offsetHeight / 2;
        const dist = Math.abs(center - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = sl;
        }
      }
      if (!best || best === state.current) return;

      for (const sl of videos()) {
        if (sl === best) continue;
        const v = sl.querySelector("video");
        if (v && !v.paused) v.pause();
      }

      state.current = best;
      const vid = parseInt(best.getAttribute("data-vid"), 10) || 0;
      const now = byId.get(vid);
      if (now) document.title = (now.title || "视频") + " · 103班 音乐领军班";

      const v = best.querySelector("video");
      if (v) {
        v.muted = false;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }

      // 快到底了就把下一页接上,别让人滑到尽头
      const idx = state.items.findIndex((x) => x.id === vid);
      if (idx >= 0 && idx >= state.items.length - 3) load(state.page + 1);
    }

    let ticking = false;
    scroll.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          setActive();
        });
      },
      { passive: true }
    );

    /* ---- 点赞 / 收藏 / 分享 ---- */

    function paintAct(btn, on_, n) {
      btn.classList.toggle("on", !!on_);
      btn.setAttribute("data-on", on_ ? "1" : "0");
      const i = btn.querySelector("i");
      const s = btn.querySelector("span");
      if (i && btn.classList.contains("v-like")) i.textContent = on_ ? "♥" : "♡";
      if (s) s.textContent = String(n);
    }

    async function toggleLike(btn) {
      const id = parseInt(btn.getAttribute("data-vlike"), 10) || 0;
      if (!id) return;
      if (!state.me) {
        toast("登录后才能点赞");
        return;
      }
      const wasOn = btn.getAttribute("data-on") === "1";
      const num = btn.querySelector("span");
      const prev = parseInt((num && num.textContent) || "0", 10) || 0;
      const nextOn = !wasOn;

      paintAct(btn, nextOn, Math.max(0, prev + (nextOn ? 1 : -1)));
      btn.classList.add("bump");
      setTimeout(() => btn.classList.remove("bump"), 420);
      try {
        const d = await api(API + "/videos/" + id + "/like", { method: "POST" });
        paintAct(btn, !!d.liked, d.likes);
      } catch (err) {
        paintAct(btn, wasOn, prev);
        toast(err.message);
      }
    }

    async function toggleFav(btn) {
      const id = parseInt(btn.getAttribute("data-vfav"), 10) || 0;
      if (!id) return;
      if (!state.me) {
        toast("登录后才能收藏");
        return;
      }
      const wasOn = btn.getAttribute("data-on") === "1";
      const num = btn.querySelector("span");
      const prev = parseInt((num && num.textContent) || "0", 10) || 0;
      const nextOn = !wasOn;

      paintAct(btn, nextOn, Math.max(0, prev + (nextOn ? 1 : -1)));
      btn.classList.add("bump");
      setTimeout(() => btn.classList.remove("bump"), 420);
      try {
        const d = await api(API + "/videos/" + id + "/fav", { method: "POST" });
        paintAct(btn, !!d.faved, d.favs);
        if (d.faved) toast("已收藏，在个人中心能看到你赞过的片子");
      } catch (err) {
        paintAct(btn, wasOn, prev);
        toast(err.message);
      }
    }

    async function share(id) {
      const url = location.origin + location.pathname + "?id=" + id;
      try {
        if (navigator.share) {
          await navigator.share({ title: "103班的视频", url });
          return;
        }
        await navigator.clipboard.writeText(url);
        toast("链接已复制，发给同学吧");
      } catch (e) {
        window.prompt("复制这个链接发给同学：", url);
      }
    }

    /* ---- 点击:暂停 / 继续 ---- */

    function flashPause(playing) {
      const sl = state.current;
      if (!sl) return;
      const tip = sl.querySelector(".v-tapzoom");
      if (!tip) return;
      tip.querySelector("i").textContent = playing ? "❚❚" : "▶";
      tip.classList.add("show");
      clearTimeout(tip._t);
      tip._t = setTimeout(() => tip.classList.remove("show"), 700);
    }

    scroll.addEventListener("click", (e) => {
      const sl = e.target.closest(".player-slide");
      if (!sl) return;
      if (e.target.closest(".v-rail") || e.target.closest(".v-meta")) return;
      const v = sl.querySelector("video");
      if (!v) return;
      if (v.paused) {
        v.play().catch(() => {});
        flashPause(true);
      } else {
        v.pause();
        flashPause(false);
      }
    });

    /* ---- 进度条 ---- */

    scroll.addEventListener(
      "timeupdate",
      (e) => {
        const v = e.target;
        if (!v || v.tagName !== "VIDEO") return;
        const dur = Number(v.duration) || 0;
        const wrap = v.parentElement && v.parentElement.querySelector(".v-bar i");
        if (wrap) wrap.style.width = dur ? Math.min(100, (v.currentTime / dur) * 100) + "%" : "0%";
      },
      true
    );

    /* ---- 评论抽屉 ---- */

    function commentHTML(c) {
      const uid = c.author && c.author.id;
      const face = uid ? `<a href="u.html?id=${uid}">${avatarHTML(c.author)}</a>` : avatarHTML(c.author);
      const name = uid
        ? `<a class="story-name" href="u.html?id=${uid}">${C103Person.html(c.author)}${badgeHTML(c.author)}</a>`
        : `<span class="story-name">已注销</span>`;
      const to = c.reply_to_name
        ? `<p class="v-cmt-to">回复 <b>@${esc(c.reply_to_name)}${c.reply_to_verified ? window.C103Person.check : ""}</b></p>`
        : "";
      return `<div class="v-cmt" data-cid="${c.id}">
        ${face}
        <div class="v-cmt-main">
          <div class="v-cmt-head">${name}<span class="v-cmt-time">${esc(fmtTime(c.created_at))}</span></div>
          ${to}
          ${c.body ? `<p class="v-cmt-body">${esc(c.body)}</p>` : ""}
          <div class="v-cmt-foot"><button class="v-cmt-btn" type="button" data-reply="${c.id}" data-name="${esc(
        C103Person.name(c.author)
      )}">回复</button></div>
        </div>
      </div>`;
    }

    function setReplyBar(name) {
      const barEl = drawer.querySelector("#v-reply-bar");
      if (!barEl) return;
      if (!name) {
        barEl.hidden = true;
        barEl.innerHTML = "";
        return;
      }
      barEl.hidden = false;
      barEl.innerHTML = `回复 <b>@${esc(name)}</b><button type="button" id="v-reply-x" aria-label="取消回复">×</button>`;
      barEl.querySelector("#v-reply-x").addEventListener("click", () => {
        state.replyTo = null;
        setReplyBar("");
      });
    }

    async function openComments(videoId) {
      const v = byId.get(videoId);
      state.replyTo = null;
      setReplyBar("");
      drawerCount.textContent = "…";
      drawerList.innerHTML = '<p class="v-cmt-empty">读取中…</p>';
      drawer.classList.add("open");
      drawer.setAttribute("data-vid", String(videoId));

      try {
        const d = await api(API + "/videos/" + videoId);
        // 顺手把列表里的计数和点赞数对齐一下
        const fresh = d.video;
        if (fresh && byId.has(videoId)) {
          const old = byId.get(videoId);
          old.likes = fresh.likes;
          old.liked = fresh.liked;
          old.favs = fresh.favs;
          old.faved = fresh.faved;
          old.comments = fresh.comments;
          syncSlide(old);
        }
        const list = d.comments || [];
        drawerCount.textContent = list.length ? list.length + " 条" : "";
        drawerList.innerHTML = list.length
          ? list.map(commentHTML).join("")
          : '<p class="v-cmt-empty">还没有人说话，来抢个沙发</p>';
        if (focusRid) {
          const target = drawerList.querySelector(`.v-cmt[data-cid="${focusRid}"]`);
          if (target) {
            target.scrollIntoView({ block: "center" });
            target.classList.add("is-focused");
          }
        }
      } catch (err) {
        drawerList.innerHTML = `<p class="v-cmt-empty">${esc(err.message)}</p>`;
      }
    }

    /* 刷新某一屏上的数字(点赞 / 评论 / 收藏) */
    function syncSlide(v) {
      const sl = scroll.querySelector(`.player-slide[data-vid="${v.id}"]`);
      if (!sl) return;
      const like = sl.querySelector("[data-vlike]");
      if (like) paintAct(like, !!v.liked, v.likes || 0);
      const cmt = sl.querySelector(".v-cmt span");
      if (cmt) cmt.textContent = String(v.comments || 0);
      const fav = sl.querySelector("[data-vfav]");
      if (fav) paintAct(fav, !!v.faved, v.favs || 0);
    }

    async function sendComment() {
      if (state.busy) return;
      const area = drawer.querySelector("#v-cmt-text");
      const body = area.value.trim();
      if (!body) {
        toast("写点什么再发吧");
        return;
      }
      if (!state.me) {
        toast("登录后才能评论");
        return;
      }
      const videoId = parseInt(drawer.getAttribute("data-vid"), 10) || 0;
      const btn = drawer.querySelector("#v-cmt-send");
      state.busy = true;
      btn.disabled = true;
      btn.textContent = "发送中";
      try {
        await api(API + "/posts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: body,
            video: videoId,
            reply_to_id: state.replyTo ? state.replyTo.id : 0,
          }),
        });
        area.value = "";
        state.replyTo = null;
        setReplyBar("");
        await openComments(videoId);
        const v = byId.get(videoId);
        if (v) {
          v.comments = (v.comments || 0) + 1;
          syncSlide(v);
        }
      } catch (err) {
        toast(err.message);
      } finally {
        state.busy = false;
        btn.disabled = false;
        btn.textContent = "发送";
      }
    }

    drawer.querySelector(".v-drawer-mask").addEventListener("click", () => {
      drawer.classList.remove("open");
    });
    drawer.querySelector("#v-drawer-x").addEventListener("click", () => {
      drawer.classList.remove("open");
    });

    scroll.addEventListener("click", (e) => {
      const like = e.target.closest("[data-vlike]");
      if (like) {
        toggleLike(like);
        return;
      }
      const cmt = e.target.closest("[data-comment]");
      if (cmt) {
        openComments(parseInt(cmt.getAttribute("data-comment"), 10) || 0);
        return;
      }
      const fav = e.target.closest("[data-vfav]");
      if (fav) {
        toggleFav(fav);
        return;
      }
      const sh = e.target.closest("[data-share]");
      if (sh) share(parseInt(sh.getAttribute("data-share"), 10) || 0);
    });

    drawerList.addEventListener("click", (e) => {
      const rep = e.target.closest("[data-reply]");
      if (!rep) return;
      if (!state.me) {
        toast("登录后才能回复");
        return;
      }
      const cid = parseInt(rep.getAttribute("data-reply"), 10) || 0;
      state.replyTo = { id: cid, name: rep.getAttribute("data-name") || "同学" };
      setReplyBar(state.replyTo.name);
      const area = drawer.querySelector("#v-cmt-text");
      area.placeholder = "回复 @" + state.replyTo.name + "…";
      area.focus();
    });

    drawer.querySelector("#v-cmt-send").addEventListener("click", sendComment);
    drawer.querySelector("#v-cmt-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendComment();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") drawer.classList.remove("open");
    });

    /* ---- 键盘上下切换(桌面端方便) ---- */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (drawer.classList.contains("open")) return;
      e.preventDefault();
      const all = videos();
      const i = state.current ? all.indexOf(state.current) : 0;
      const next = all[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) next.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    /* ---- 起播 ---- */
    authReady().then((user) => {
      state.me = user;
      if (window.C103Auth) {
        window.C103Auth.onChange((u) => {
          state.me = u;
        });
      }
      load(1);
    });
  }

  /* ---------- 启动 ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    if (location.protocol === "file:") return;
    mountUpload();
    mountPlayer();
  });
})();
