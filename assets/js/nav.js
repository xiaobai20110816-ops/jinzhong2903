/* ============================================================
   103班：音乐领军班 · 顶部导航脚本
   动态注入导航栏 + 主题开关 + 底部,所有页面共用
   ============================================================ */

// 导航配置：改了导航项,所有页面一起变
const NAV_ITEMS = [
  { href: "index.html", label: "首页" },
  { href: "students.html", label: "学生风采" },
  { href: "dormitory.html", label: "宿舍风采" },
  { href: "moments.html", label: "高光时刻" },
  { href: "announcements.html", label: "班级公告" },
];

// 主题存在 localStorage:dark(默认) / light
const THEME_KEY = "class103-theme";
const THEME_COLORS = { dark: "#070b14", light: "#f4f6fa" };

function readTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  // 深色是默认值,直接摘掉属性,少一层覆盖
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else document.documentElement.removeAttribute("data-theme");

  // 手机浏览器地址栏跟着变色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[theme]);

  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 隐私模式下忽略 */ }
}

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
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="切换深色 / 浅色模式">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2"></circle>
          <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"></path>
        </svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z"></path>
        </svg>
      </button>
      <button id="nav-toggle" class="nav-toggle" aria-label="打开菜单" data-nav>
        <span></span><span></span><span></span>
      </button>
    </div>`;
  document.body.prepend(header);

  // ---- 注入底部信息栏(固定不随滚动消失) ----
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `青春交响，永不散场<i>/</i>金华一中 103班<i>/</i>班主任：盛姗`;
  document.body.appendChild(footer);

  // ---- 主题开关 ----
  const themeBtn = document.getElementById("theme-toggle");
  themeBtn.addEventListener("click", () => {
    applyTheme(readTheme() === "light" ? "dark" : "light");
  });

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