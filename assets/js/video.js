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
  const MAX_SRC = 500 * 1024 * 1024;   // 选片上限:再大浏览器自己也扛不住
  const MAX_OUT = 80 * 1024 * 1024;    // 传上去的上限,和后端保持一致
  const PAGE_SIZE = 20;

  /* 上传画质档位。原画质 = 不压,直接传原文件;
     其余三档都是「在本地把画面重画到指定高度,再录一遍」。
     kbps 是目标视频码率,只用来估个大小和喂给编码器。 */
  const LEVELS = [
    { id: "orig", name: "原画质", note: "不压缩", maxH: 0, kbps: 0 },
    { id: "hd", name: "1080p", note: "清晰优先", maxH: 1080, kbps: 4000 },
    { id: "sd", name: "720p", note: "推荐", maxH: 720, kbps: 1800 },
    { id: "low", name: "480p", note: "最省流量", maxH: 480, kbps: 900 },
  ];

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

  /* 评论 / 视频简介里的正文:转义 + 把 [emoji:名字] 换成表情图 */
  function richText(s) {
    return window.C103Emoji ? window.C103Emoji.render(s) : esc(s);
  }

  function emojiReady() {
    if (!window.C103Emoji) return Promise.resolve();
    return window.C103Emoji.load().catch(() => {});
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

  /* ---------- 本地压缩 ----------
     浏览器里能通用的一条路只有「canvas 重画 + MediaRecorder 录」:
     把原片静音播一遍,按目标分辨率逐帧画到 canvas 上,画面和原片的音轨
     一起录成一段新视频。代价是录制走真实时间 —— 1 分钟的视频就要等 1 分钟,
     所以进度按播放进度走,过程中不能切走标签页(切走后浏览器会降帧)。 */

  function pickMime() {
    if (typeof MediaRecorder === "undefined") return "";
    const list = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const m of list) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) {
        /* 个别浏览器 isTypeSupported 会抛,跳过这档继续试 */
      }
    }
    return "";
  }

  function compressVideo(file, level, onProgress) {
    return new Promise((resolve, reject) => {
      const mime = pickMime();
      if (!mime) {
        reject(new Error("这个浏览器不能在本地压缩，换 Chrome / Edge，或选「原画质」直接传"));
        return;
      }

      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      let ac = null;
      let raf = 0;
      let done = false;

      const clean = () => {
        cancelAnimationFrame(raf);
        try { v.pause(); } catch (e) {}
        v.removeAttribute("src");
        v.load();
        URL.revokeObjectURL(url);
        if (v.parentNode) v.parentNode.removeChild(v);
        if (ac && ac.close) { try { ac.close(); } catch (e) {} }
      };
      const die = (err) => {
        if (done) return;
        done = true;
        clean();
        reject(err);
      };

      v.preload = "auto";
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
      document.body.appendChild(v);
      v.src = url;

      v.onerror = () => die(new Error("这个视频浏览器打不开，换成 MP4 再试"));

      v.onloadedmetadata = () => {
        const dur = Number(v.duration) || 0;
        if (!dur) {
          die(new Error("读不出这段视频的时长，选「原画质」直接传吧"));
          return;
        }

        const w0 = v.videoWidth || 720;
        const h0 = v.videoHeight || 1280;
        const scale = Math.min(1, level.maxH / h0);
        // 编码器要求宽高是偶数,不然个别浏览器直接失败
        const cw = Math.max(2, Math.round((w0 * scale) / 2) * 2);
        const chh = Math.max(2, Math.round((h0 * scale) / 2) * 2);

        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = chh;
        const ctx = canvas.getContext("2d");

        let stream;
        try {
          stream = canvas.captureStream(30);
        } catch (e) {
          die(new Error("这个浏览器抓不了画面，选「原画质」直接传吧"));
          return;
        }

        // 声音从原片接过来,并且只接到录制目标 —— 所以压缩过程是静音的
        let hasAudio = false;
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            ac = new AC();
            if (ac.resume) ac.resume();
            const node = ac.createMediaElementSource(v);
            const dest = ac.createMediaStreamDestination();
            node.connect(dest);
            const tracks = dest.stream.getAudioTracks();
            if (tracks.length) {
              stream.addTrack(tracks[0]);
              hasAudio = true;
            }
          }
        } catch (e) {
          hasAudio = false;
        }
        // 接不上音轨就静音播,免得压的时候外放吵人
        v.muted = !hasAudio;

        let recorder;
        try {
          recorder = new MediaRecorder(stream, {
            mimeType: mime,
            videoBitsPerSecond: level.kbps * 1000,
            audioBitsPerSecond: 96000,
          });
        } catch (e) {
          die(new Error("这台设备没法压缩，选「原画质」直接传吧"));
          return;
        }

        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.onerror = () => die(new Error("压缩中断了，重试一次"));
        recorder.onstop = () => {
          if (done) return;
          const type = (mime.split(";")[0] || "video/webm").trim();
          const blob = new Blob(chunks, { type: type });
          if (!blob.size) {
            die(new Error("压出来是空的，选「原画质」直接传吧"));
            return;
          }
          done = true;
          clean();
          resolve(blob);
        };

        // 一直画到录完为止:play() 是异步的,所以循环不能因为「还没开始播」就退出
        const draw = () => {
          if (done) return;
          if (!v.paused && !v.ended) {
            ctx.drawImage(v, 0, 0, cw, chh);
            if (onProgress) onProgress(Math.min(1, v.currentTime / dur));
          }
          raf = requestAnimationFrame(draw);
        };

        v.onended = () => {
          try { ctx.drawImage(v, 0, 0, cw, chh); } catch (e) {}
          if (recorder.state !== "inactive") recorder.stop();
        };

        recorder.start(400);
        const p = v.play();
        if (p && p.catch) {
          p.catch((err) => {
            die(new Error(
              err && err.name === "NotAllowedError"
                ? "浏览器拦下了自动播放，点一下页面再点发布"
                : "这个视频播不起来，选「原画质」直接传吧"
            ));
          });
        }
        draw();
      };
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
    const levelBox = box.querySelector("#v-level");
    const levelRow = box.querySelector("#v-level-row");
    const levelNote = box.querySelector("#v-level-note");

    const state = {
      file: null, cover: null, duration: 0, width: 0, height: 0, busy: false,
      level: "orig",
      canCompress: !!pickMime(),
    };

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
      state.level = "orig";
      if (preview) {
        preview.hidden = true;
        preview.removeAttribute("src");
      }
      if (metaRow) metaRow.innerHTML = "";
      if (levelBox) levelBox.hidden = true;
      drop.hidden = false;
    }

    /* 画质档位:没选片时整块藏起来;选完按原片的清晰度和体积挑一个默认档 */
    function paintLevels() {
      if (!levelBox || !levelRow) return;
      if (!state.file) {
        levelBox.hidden = true;
        return;
      }
      levelBox.hidden = false;
      levelRow.innerHTML = LEVELS.map((lv) => {
        const off = lv.id !== "orig" && !state.canCompress;
        return `<button type="button" class="v-level-opt${state.level === lv.id ? " active" : ""}" data-level="${lv.id}"${off ? " disabled" : ""}>
          <b>${lv.name}</b><em>${lv.note}</em>
        </button>`;
      }).join("");

      const lv = LEVELS.filter((x) => x.id === state.level)[0] || LEVELS[0];
      if (levelNote) {
        if (lv.id === "orig") {
          levelNote.textContent = state.canCompress
            ? `原文件 ${fmtSize(state.file.size)}，原样上传，最清楚也最占流量`
            : `原文件 ${fmtSize(state.file.size)}，原样上传`;
        } else {
          const est = (lv.kbps * 1000 * state.duration) / 8;
          const save = state.file.size > 0 ? Math.max(0, 1 - est / state.file.size) : 0;
          levelNote.textContent =
            `压到 ${lv.maxH}p 大约 ${fmtSize(est)}` +
            (save > 0.05 ? `，比原片小 ${Math.round(save * 100)}%` : "") +
            `；压缩要按片长实时走一遍（这段约 ${Math.ceil(state.duration)} 秒），过程中别关页面`;
        }
      }
    }

    drop.addEventListener("click", () => file.click());
    if (levelRow) {
      levelRow.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-level]");
        if (!opt || opt.disabled) return;
        state.level = opt.getAttribute("data-level") || "orig";
        paintLevels();
      });
    }

    file.addEventListener("change", async () => {
      const f = (file.files || [])[0];
      file.value = "";
      if (!f) return;

      reset();
      if (!/^video\//.test(f.type) && !/\.(mp4|webm|mov|m4v)$/i.test(f.name)) {
        say("只收 MP4 / WebM / MOV 视频", "err");
        return;
      }
      if (f.size > MAX_SRC) {
        say(
          "这个视频有 " + fmtSize(f.size) + "，太大了，先剪短一点（上限 " +
            Math.round(MAX_SRC / 1048576) + "MB）",
          "err"
        );
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
        // 手机拍的片子默认压一档;本来就是小片子就原样传,省得白等
        const big = info.height > 720 || f.size > 24 * 1024 * 1024;
        state.level = big && state.canCompress ? "sd" : "orig";
        paintLevels();
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
      submit.textContent = "准备中";
      progress.hidden = false;
      bar.style.width = "0%";
      if (levelRow) levelRow.querySelectorAll(".v-level-opt").forEach((b) => (b.disabled = true));

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

        // 要压就先在本地压一遍,压完才上传 —— 大文件全靠这一步才传得上去
        const lv = LEVELS.filter((x) => x.id === state.level)[0] || LEVELS[0];
        let out = state.file;
        if (lv.id !== "orig") {
          if (!state.canCompress) {
            say("这个浏览器压不了，换 Chrome / Edge，或把画质改成「原画质」", "err");
            return;
          }
          submit.textContent = "压缩中";
          bar.style.width = "0%";
          say("正在压缩，别关页面、别切走标签页…（0%）");
          const blob = await compressVideo(state.file, lv, (p) => {
            const pct = Math.round(p * 100);
            bar.style.width = pct + "%";
            say(`正在压缩，别关页面、别切走标签页…（${pct}%）`);
          });
          const ext = blob.type.indexOf("mp4") >= 0 ? "mp4" : "webm";
          out = new File([blob], "clip." + ext, { type: blob.type });
          const cut = 1 - out.size / state.file.size;
          say(
            `压好了：${fmtSize(state.file.size)} → ${fmtSize(out.size)}` +
              (cut > 0.03 ? `（小了 ${Math.round(cut * 100)}%）` : "") +
              "，开始上传…",
            "ok"
          );
        }

        if (out.size > MAX_OUT) {
          say(`还是 ${fmtSize(out.size)}，超过 80MB，换更低一档再试`, "err");
          return;
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

        submit.textContent = "上传中";
        bar.style.width = "0%";
        say("正在上传视频，别关页面…（0%）");
        await putVideo(out, q.toString(), (p) => {
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
        if (state.file) paintLevels();
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

    // 从底部那个「＋」跳过来的:等上传区亮出来,直接滚到位
    if (new URLSearchParams(location.search).get("post")) {
      const jump = () => {
        if (box.hidden) return false;
        box.scrollIntoView({ behavior: "smooth", block: "start" });
        return true;
      };
      if (!jump()) {
        let n = 0;
        const t = setInterval(() => {
          if (jump() || ++n > 25) clearInterval(t);
        }, 200);
      }
    }
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
          ${v.body ? `<p class="v-body">${richText(v.body)}</p>` : ""}
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
        await emojiReady();
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
          ${c.body ? `<p class="v-cmt-body">${richText(c.body)}</p>` : ""}
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
      await emojiReady();
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

    // 评论框的表情按钮
    if (window.C103Emoji) {
      window.C103Emoji.mount(drawer.querySelector("#v-cmt-emoji"), drawer.querySelector("#v-cmt-text"));
    }

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
