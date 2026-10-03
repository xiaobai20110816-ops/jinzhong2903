/* ============================================================
   103班：音乐领军班 · 学生数据与渲染
   名单已支持后台编辑:数据来自 GET /api/content 的 students 板块,
   以后增删同学请到「管理后台」操作,不用再改这个文件。
   拿不到内容(断网 / 接口没接上)时,退回下面这份兜底名单;
   兜底为空就显示「COMING SOON / 敬请期待」,页面永远不会空白。
   ============================================================ */

// 兜底名单(接口拿不到内容时用),留空即显示「敬请期待」
const STUDENTS = [];

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("students-grid");
  if (!grid) return;

  // 来自接口的文本统一转义后再拼进 innerHTML
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const img = window.C103Img || ((v) => v);

  // 名单为空时显示「敬请期待」(原样保留)
  const renderSoon = () => {
    grid.innerHTML = `
      <div class="students-soon">
        <p class="soon-en">COMING SOON</p>
        <h2 class="soon-cn">敬请期待</h2>
        <p class="soon-note">名单整理中,同学们的风采即将登场。</p>
      </div>`;
  };

  const render = (list) => {
    // 加载失败 / 列表为空都退回兜底名单
    const students = Array.isArray(list) && list.length ? list : STUDENTS;
    if (!students.length) return renderSoon();

    grid.innerHTML = students
      .map((s) => {
        const name = String(s.name || "");
        // 有头像用头像,没有就显示名字首字
        const face = s.avatar
          ? `<img src="${esc(img(s.avatar))}" alt="${esc(name)}">`
          : esc(name.charAt(0));
        return `
      <figure class="student-card">
        <div class="student-avatar">${face}</div>
        <h3>${esc(name)}</h3>
        <span class="position">${esc(s.tag || "")}</span>
      </figure>`;
      })
      .join("");
  };

  // load() 失败时 resolve 出 null,render 会退回兜底,不会空白
  if (!window.C103Content) return renderSoon();
  C103Content.load().then((content) => render(content && content.students));
});
