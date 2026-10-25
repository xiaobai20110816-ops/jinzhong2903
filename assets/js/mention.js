/* ============================================================
   103 · @ 同学
   任何带 data-mention 的 textarea 都会自动挂上这个输入框:
   打出一个 @ 就弹出候选,关注的人排在最前,第一项固定是「AI 助手」。
   选中后把「@名字 」填进光标位置,后面的文字不动。

   也支持动态生成的输入框:window.C103Mention.attach(el)。
   ============================================================ */
(function () {
  "use strict";

  const AI_ITEM = { id: 0, name: "AI 助手", ai: 1, desc: "回答问题、点评照片和视频" };

  let pop = null; // 全站共用一个浮层,同一时刻只有一个输入框在用
  let active = null; // 当前挂着的 textarea
  let items = [];
  let cursor = 0;
  let token = null;
  let timer = 0;
  let seq = 0; // 丢弃过期请求的响应
  let attached = new WeakSet();

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* 光标前面那段是不是一个还没打完的 @关键词 */
  function tokenAt(el) {
    const pos = el.selectionStart;
    if (pos == null) return null;
    const before = el.value.slice(0, pos);
    const m = before.match(/@([^\s@，。！？、,.!?；;：:]{0,20})$/);
    if (!m) return null;
    return { start: pos - m[0].length, end: pos, q: m[1] };
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "mention-pop";
    pop.hidden = true;
    document.body.appendChild(pop);
    // 用 mousedown 而不是 click:blur 抢在 click 前面,不拦住就选不中
    pop.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-i]");
      if (!btn) return;
      e.preventDefault();
      pick(parseInt(btn.getAttribute("data-i"), 10) || 0);
    });
    return pop;
  }

  function place(el) {
    const box = ensurePop();
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 220), 320);
    box.style.width = width + "px";
    // 默认贴在输入框上方;上面放不下就翻到下方
    const approx = Math.min(items.length, 7) * 46 + 12;
    let top = r.top - approx - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - approx - 8);
    box.style.left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8) + "px";
    box.style.top = Math.max(8, top) + "px";
  }

  function render() {
    if (!items.length) {
      hide();
      return;
    }
    const box = ensurePop();
    box.innerHTML = items
      .map((it, i) => {
        const av = it.ai
          ? `<span class="mp-av mp-av-ai">AI</span>`
          : it.avatar
          ? `<img class="mp-av" src="api/img/${encodeURIComponent(it.avatar)}" alt="">`
          : `<span class="mp-av">${esc(String(it.name || "?").slice(0, 1))}</span>`;
        const tag = it.ai
          ? `<span class="mp-tag ai">${esc(it.desc || "")}</span>`
          : it.followed
          ? `<span class="mp-tag">已关注</span>`
          : "";
        return `<button type="button" class="mp-item${i === cursor ? " on" : ""}" data-i="${i}">
          ${av}<span class="mp-name">${esc(it.name)}</span>${tag}
        </button>`;
      })
      .join("");
    box.hidden = false;
    if (active) place(active);
  }

  function hide() {
    if (pop) pop.hidden = true;
    items = [];
    cursor = 0;
  }

  function pick(i) {
    const it = items[i];
    if (!it || !active || !token) return;
    const el = active;
    const text = "@" + it.name + " ";
    el.setRangeText(text, token.start, token.end, "end");
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
  }

  async function search(q) {
    const my = ++seq;
    try {
      const res = await fetch("api/mention?q=" + encodeURIComponent(q), {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("bad");
      const d = await res.json();
      if (my !== seq) return; // 又来了一次输入,这次结果作废
      items = [AI_ITEM].concat(
        (d.list || []).map((u) => ({ ...u, ai: 0 }))
      );
      cursor = 0;
      render();
    } catch (e) {
      hide();
    }
  }

  function onInput() {
    const el = active;
    if (!el) return;
    token = tokenAt(el);
    if (!token) {
      hide();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => search(token.q), 150);
  }

  function onKey(e) {
    if (!pop || pop.hidden || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = (cursor + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = (cursor - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      // 候选开着时 Enter 是「选中」,不是「发送」
      e.preventDefault();
      e.stopPropagation();
      pick(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  }

  function attach(el) {
    if (!el || attached.has(el)) return;
    attached.add(el);
    el.addEventListener("focus", () => {
      active = el;
    });
    el.addEventListener("input", () => {
      active = el;
      onInput();
    });
    el.addEventListener("keydown", onKey, true);
    el.addEventListener("blur", () => {
      // 让 mousedown 先完成选中,再收起
      setTimeout(() => {
        if (active === el) hide();
      }, 160);
    });
  }

  function attachAll(root) {
    (root || document).querySelectorAll("textarea[data-mention]").forEach(attach);
  }

  window.C103Mention = { attach, attachAll };

  document.addEventListener("DOMContentLoaded", () => {
    attachAll(document);
    // 页面里后插进来的输入框(比如展开的回复框),交给调用方 attach;
    // 这里再兜一层:点进任何 textarea[data-mention] 都补挂一次
    document.addEventListener("focusin", (e) => {
      const el = e.target;
      if (el && el.tagName === "TEXTAREA" && el.hasAttribute("data-mention")) attach(el);
    });
  });
})();
