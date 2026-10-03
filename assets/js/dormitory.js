/* ============================================================
   103班：音乐领军班 · 宿舍数据与渲染
   数据来自 GET /api/content 的 dorms 板块,以后改宿舍信息去「管理后台」,
   不用再改这个文件;下面这份 DORMS 仅在接口拿不到内容时兜底。
   - nick    宿舍昵称,留空显示「昵称待补充」
   - members 成员昵称列表,留空显示占位
   - photos  照片数组,第一张作为合照大图,其余作为缩略图
             点击大图可在灯箱里查看完整原图(竖拍照片不裁切)
   ============================================================ */

// 兜底数据:接口拿不到内容时用它,保持页面和以前一模一样
const DORMS = [
  {
    number: "311",
    nick: "皇家园区",
    members: [],
    photos: [
      "assets/images/dorm/311/1.jpg",
      "assets/images/dorm/311/2.jpg",
      "assets/images/dorm/311/3.jpg",
      "assets/images/dorm/311/4.jpg",
      "assets/images/dorm/311/5.jpg",
      "assets/images/dorm/311/6.jpg",
      "assets/images/dorm/311/7.jpg",
      "assets/images/dorm/311/8.jpg",
      "assets/images/dorm/311/9.jpg",
      "assets/images/dorm/311/10.jpg",
      "assets/images/dorm/311/11.jpg",
      "assets/images/dorm/311/12.jpg",
    ],
  },
  {
    number: "312",
    nick: "大诚酒店",
    members: [],
    photos: [
      "assets/images/dorm/312/1.jpg",
      "assets/images/dorm/312/2.jpg",
    ],
  },
  { number: "409", nick: "", members: [], photos: [] },
  {
    number: "410",
    nick: "金楚涵教总部",
    members: [],
    photos: [
      "assets/images/dorm/410/1.jpg",
      "assets/images/dorm/410/2.jpg",
      "assets/images/dorm/410/3.jpg",
    ],
  },
  {
    number: "411",
    nick: "法兰西室联盟",
    members: [],
    photos: [
      "assets/images/dorm/411/1.jpg",
      "assets/images/dorm/411/2.jpg",
      "assets/images/dorm/411/3.jpg",
      "assets/images/dorm/411/4.jpg",
    ],
  },
  {
    number: "412",
    nick: "",
    members: [],
    photos: [
      "assets/images/dorm/412/1.jpg",
      "assets/images/dorm/412/2.jpg",
      "assets/images/dorm/412/3.jpg",
      "assets/images/dorm/412/4.jpg",
      "assets/images/dorm/412/5.jpg",
    ],
  },
];

document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("dorm-grid");
  if (!grid) return;

  // 来自接口的文本 / 图片地址统一处理(图片地址必须过 C103Img)
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const img = window.C103Img || ((v) => v);

  // ---------- 灯箱 ----------
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxCaption = document.getElementById("lightbox-caption");
  const lightboxCounter = document.getElementById("lightbox-counter");
  const btnPrev = document.getElementById("lightbox-prev");
  const btnNext = document.getElementById("lightbox-next");
  const btnClose = document.getElementById("lightbox-close");

  let state = { photos: [], index: 0, dorm: "" };

  function openLightbox(card, photos, index) {
    if (!photos.length) return;
    state = { photos, index, dorm: card.dataset.dorm };
    paint();
    lightbox.classList.add("show");
  }

  function paint() {
    lightboxImg.src = state.photos[state.index];
    lightboxCaption.textContent = `宿舍 ${state.dorm}`;
    lightboxCounter.textContent = `${state.index + 1} / ${state.photos.length}`;
    const many = state.photos.length > 1;
    btnPrev.hidden = !many;
    btnNext.hidden = !many;
  }

  function step(delta) {
    const n = state.photos.length;
    if (!n) return;
    state.index = (state.index + delta + n) % n;
    paint();
  }

  function closeLightbox() {
    lightbox.classList.remove("show");
  }

  btnPrev.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
  btnNext.addEventListener("click", (e) => { e.stopPropagation(); step(1); });
  btnClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();   // 点背景关闭
  });
  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("show")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  // ---------- 渲染卡片 ----------
  const render = (list) => {
    // 加载失败 / 列表为空都退回写死的 DORMS
    const dorms = Array.isArray(list) && list.length ? list : DORMS;
    const rendered = new Map(); // 本次实际渲染用的照片数组,缩略图切换和灯箱都从这里取

    grid.innerHTML = dorms.map((d) => {
      const photos = (d.photos || []).map((p) => img(p));
      rendered.set(String(d.number), photos);

      const cover = photos.length
        ? `<img class="dorm-cover" src="${esc(photos[0])}" alt="宿舍 ${esc(d.number)} 合照">`
        : `<span>宿 舍 ${esc(d.number)} · 合 照</span>`;

      const thumbs =
        photos.length > 1
          ? `<div class="dorm-thumbs">${photos
              .map(
                (p, i) =>
                  `<img src="${esc(p)}" data-index="${i}" class="${i === 0 ? "active" : ""}" alt="宿舍 ${esc(d.number)} 照片 ${i + 1}">`
              )
              .join("")}</div>`
          : "";

      const name = d.nick ? `「${esc(d.nick)}」` : `「昵称待补充」`;
      const members = (d.members || []).length
        ? d.members.map((m) => `<li>${esc(m)}</li>`).join("")
        : `<li>成员昵称待补充</li>`;

      return `
      <article class="dorm-card" data-dorm="${esc(d.number)}" data-active="0">
        <div class="dorm-photo">${cover}</div>
        ${thumbs}
        <div class="dorm-body">
          <h3>${esc(d.number)}</h3>
          <span class="dorm-nick">${name}</span>
          <ul class="dorm-members">${members}</ul>
        </div>
      </article>`;
    }).join("");

    // ---------- 卡片内交互 ----------
    grid.querySelectorAll(".dorm-card").forEach((card) => {
      const photos = rendered.get(card.dataset.dorm) || [];
      const cover = card.querySelector(".dorm-cover");

      // 点缩略图:切换本宿舍的合照大图
      card.querySelectorAll(".dorm-thumbs img").forEach((thumb) => {
        thumb.addEventListener("click", () => {
          const i = Number(thumb.dataset.index);
          card.dataset.active = String(i);
          if (cover) cover.src = photos[i];
          card.querySelectorAll(".dorm-thumbs img").forEach((t) =>
            t.classList.toggle("active", t === thumb)
          );
        });
      });

      // 点大图:灯箱查看完整原图(从当前这张开始)
      if (cover) {
        cover.addEventListener("click", () => openLightbox(card, photos, Number(card.dataset.active)));
      }
    });
  };

  // load() 失败时 resolve 出 null,render 会退回 DORMS,不会空白
  if (!window.C103Content) return render(null);
  C103Content.load().then((content) => render(content && content.dorms));
});
