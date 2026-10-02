/* ============================================================
   103班：音乐领军班 · 学生数据与渲染
   名单整理中,暂显示「敬请期待」
   以后替换真实学生信息,只改 STUDENTS 数组:
     { name: "姓名", nick: "人物定位标签", photo: "头像路径(可留空)" }
   ============================================================ */

const STUDENTS = [];

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("students-grid");
  if (!grid) return;

  // 名单为空时显示「敬请期待」
  if (!STUDENTS.length) {
    grid.innerHTML = `
      <div class="students-soon">
        <p class="soon-en">COMING SOON</p>
        <h2 class="soon-cn">敬请期待</h2>
        <p class="soon-note">名单整理中,同学们的风采即将登场。</p>
      </div>`;
    return;
  }

  grid.innerHTML = STUDENTS.map(
    (s) => `
      <figure class="student-card">
        <div class="student-avatar">${s.photo ? `<img src="${s.photo}" alt="${s.name}">` : s.name.charAt(0)}</div>
        <h3>${s.name}</h3>
        <span class="position">${s.nick}</span>
      </figure>`
  ).join("");
});