/* ============================================================
   103班：音乐领军班 · 顶部导航脚本
   动态注入导航栏 + 底部,所有页面共用,避免重复写
   ============================================================ */

// 导航配置：改了导航项,所有页面一起变
const NAV_ITEMS = [
  { href: "index.html", label: "首页" },
  { href: "students.html", label: "学生风采" },
  { href: "dormitory.html", label: "宿舍风采" },
  { href: "moments.html", label: "高光时刻" },
  { href: "announcements.html", label: "班级公告" },
];

document.addEventListener("DOMContentLoaded", () => {
  // 当前页面文件名,用于高亮
  const current = location.pathname.split("/").pop() || "index.html";

  // ---- 注入导航栏 ----
  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `
    <div class="container nav">
      <a class="nav-logo" href="index.html" data-nav>
        <img src="assets/images/logo.svg" alt="103班 Logo">
        <span><b>103 · 音乐领军班</b><small>Musical Vanguards</small></span>
      </a>
      <nav id="nav-links" class="nav-links">
        ${NAV_ITEMS.map(
          (n) => `<a href="${n.href}" data-nav ${n.href === current ? 'class="active"' : ""}>${n.label}</a>`
        ).join("")}
      </nav>
      <button id="nav-toggle" class="nav-toggle" aria-label="打开菜单" data-nav>
        <span></span><span></span><span></span>
      </button>
    </div>`;
  document.body.prepend(header);

  // ---- 注入底部信息栏(与首页海报底部保持一致,固定不随滚动消失) ----
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `青春交响，永不散场<i>/</i>金华一中 103班<i>/</i>班主任：盛姗`;
  document.body.appendChild(footer);

  // ---- 手机汉堡菜单开合 ----
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle.classList.toggle("open");
    links.classList.toggle("open");
  });

  // 点击导航链接后自动收起菜单
  document.querySelectorAll("#nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      toggle.classList.remove("open");
      links.classList.remove("open");
    });
  });
});