/* ============================================================
   103班：音乐领军班 · 学生风采
   名单来自账号:GET /api/students 只返回「实名审核通过」的账号。
   真名 / 蓝钩按看的人的权限下发 —— 服主 · 管理员 · 已实名的同学
   看到真名 + 蓝色小钩,其他人看到账号名。
   一个已审核的都没有时显示「敬请期待」,页面永远不会空白。
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("students-grid");
  if (!grid) return;

  // 来自接口的文本统一转义后再拼进 innerHTML
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const img = window.C103Img || ((v) => v);
  const P = window.C103Person; // 名字 + 蓝钩的统一渲染(nav.js 里)

  const ROLE_LABEL = { owner: "服主", admin: "管理员" };

  // 没有已审核的账号时显示「敬请期待」(原样保留)
  const renderSoon = (note) => {
    grid.innerHTML = `
      <div class="students-soon">
        <p class="soon-en">COMING SOON</p>
        <h2 class="soon-cn">敬请期待</h2>
        <p class="soon-note">${esc(note || "名单整理中,同学们的风采即将登场。")}</p>
      </div>`;
  };

  const render = (list) => {
    const students = Array.isArray(list) ? list : [];
    if (!students.length) return renderSoon("实名审核还在进行，通过的同学会陆续登场。");

    grid.innerHTML = students
      .map((s) => {
        const name = P ? P.name(s) : s.name || "";
        const shown = P ? P.html(s) : esc(name);
        // 有头像用头像,没有就显示名字首字
        const face = s.avatar
          ? `<img src="${esc(img(s.avatar))}" alt="${esc(name)}">`
          : esc(String(name).charAt(0) || "?");
        const role = ROLE_LABEL[s.role]
          ? `<em class="student-role ${esc(s.role)}">${ROLE_LABEL[s.role]}</em>`
          : "";
        const tag = s.signature ? `<span class="position">${esc(s.signature)}</span>` : "";
        return `
      <a class="student-card" href="u.html?id=${encodeURIComponent(s.id)}">
        <div class="student-avatar">${face}</div>
        <h3>${shown}${role}</h3>
        ${tag}
      </a>`;
      })
      .join("");
  };

  if (!window.C103Auth) return renderSoon("名单暂时读不到，刷新一下再试。");

  // 先等 nav.js 问清楚「我是谁」:真名和蓝钩取决于看的人是谁
  Promise.resolve(window.C103Auth.ready)
    .then(() => fetch("api/students", { credentials: "same-origin" }))
    .then((r) => r.json().then((d) => ({ ok: r.ok, d: d })))
    .then(({ ok, d }) => {
      if (!ok || !d.ok) throw new Error((d && d.error) || "读不到名单");
      render(d.students);
    })
    .catch(() => renderSoon("名单暂时读不到，刷新一下再试。"));
});
