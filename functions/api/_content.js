/* ============================================================
   103 · 站点内容中心

   全站的可编辑内容都放在 D1 的 content 表里,一行一个板块:
     key = site / announcements / students / dorms / moments
   第一次被访问时,把原先写死在页面里的内容灌进去(INSERT OR IGNORE),
   所以老站点的样子一点不变,只是从此可以在后台改了。
   ============================================================ */

export const CONTENT_KEYS = ["site", "announcements", "students", "dorms", "moments"];

const MAX_VALUE_BYTES = 240 * 1024; // 单个板块最多 240KB,防止被人塞爆

/* 首页与各页面的默认文案 */
const DEFAULT_SITE = {
  heroKicker: "Jinhua No.1 High School",
  heroTitle: "103",
  heroTitleSuffix: "班",
  heroTagline: "CLASS 103 · MUSICAL VANGUARDS",
  heroYear: "2026",
  studentsLede: "名单整理中，即将公布",
  momentsNote: "合唱比赛 · 96.95 分 · 位列第一/另有宿舍游行视频",
  footerItems: ["青春交响，永不散场", "金华一中 103班", "班主任：盛老师", "鸣谢：小柏制作"],
  thanksTitle: "鸣谢",
  thanksName: "小柏制作",
};

const DEFAULT_ANNOUNCEMENTS = [
  {
    date: "2026.10.05",
    title: "全站更新总览｜从上线到现在",
    pinned: true,
    body: [
      "金秋十月，103 班官网从一块空白画布，一点点长成了现在的样子。下面把这段时间的每一次更新，从头到尾梳理一遍 —— 这是我们自己搭建、自己维护的数字阵地。",
      "",
      "## 一、官网起步（10 月 3 日）",
      "官网正式上线，第一批功能就位：",
      "- 自由注册登录：起个名字、传张头像、写一句个性签名，发帖不用再手填名字",
      "- 留言板：像 B 站那样逐条回复，点「回复」就地展开",
      "- IP 属地：每条留言下面标注省份，都是自己人，坦坦荡荡",
      "- 图片上传：最多 3 张，自动压缩，传得快也看得清",
      "- 服主标识：班委账号带金色徽章，发布的通知自动置顶",
      "",
      "## 二、账号、登录与权限",
      "- 一次性激活口令：输入后导航栏出现「管理后台」入口，**只能用一次，用完永久作废**",
      "- 三级身份：服主 / 管理员 / 普通成员，权限逐级区分，各司其职",
      "- 服主认证：服主名字后面挂一枚**金色认证徽章**（推特那种金勾），全站统一显示",
      "- 服主可封禁 / 解封、改用户名、重置密码、彻底删除账号；管理员可删帖置顶、审核实名",
      "- 实名审核：通过的同学名字后面加**蓝色小钩**；真名由后端按权限决定谁看得见",
      "- 登录记忆：刷新不掉线，网络抖动自动重试，不用反复登录",
      "",
      "## 三、留言板与互动",
      "- 平铺回复：点「回复」就地展开，用「回复 @某某」说明关系，不层层缩进",
      "- 服主发的帖子自动置顶，服主和管理员还能手动置顶任意帖子",
      "- 「仅本班可见」：游客看不到的帖子，接口层就过滤掉，不给看就是不给看",
      "- 删帖会连带删掉下面所有回复和相关图片，不留孤零零的回复",
      "- 点赞、留言墙、个人主页互通，点留言里的头像就能进 TA 的主页",
      "- 互动通知：导航栏小铃铛亮红点，谁回复了你、谁赞了你一目了然；点开一条通知，会**直接翻到那一页、滚到那条回复并描金高亮**",
      "",
      "## 四、个人主页与活跃榜",
      "- 个人主页：看 TA 发过的帖子、给 TA 点赞、在 TA 的留言墙留言",
      "- 公开活跃榜：发帖榜、人气榜（被点赞）、人缘榜（被留言）、最热闹的帖子，点名字直达主页",
      "- 班级成就：笔杆子（发布 10 条主帖）、人气王（主页被赞 5 次）、社交达人（评论过 10 个人），未解锁的显示进度条",
      "",
      "## 五、学生风采",
      "- 改成账号驱动：只有通过实名、且未被封禁的同学才会出现在上面",
      "- 卡片整张可点，直接进入 TA 的个人主页",
      "- 一个都没审核时，显示「敬请期待」",
      "",
      "## 六、视觉与交互",
      "- 四套皮肤：鎏金 / 极光 / 蔷薇 / 松林，深浅两套变体，导航栏「外观」按钮里随时换，换完记住",
      "- 全站玻璃质感：半透明底 + 背景模糊 + 高光描边 + 斜向掠光",
      "- 导航栏灵动岛：往下滚，整条导航收成左边一个小圆；点圆展开，点页面空白收回，滑回顶部自动复位",
      "- 子页面页头升级：细网格地层、四角描金 HUD 括号、玻璃药丸眉标、中间亮两边淡的分割线",
      "- 首页：视频封面 + 粒子背景，宿舍照片自动轮播（转一张、停一会儿的节奏）",
      "- 页面之间平滑过渡，不白屏；底部信息栏全站统一",
      "",
      "## 七、性能优化",
      "- 找到掉帧的真凶：带毛玻璃的元素，只要尺寸每帧改动，就得每帧重新算一遍背景模糊",
      "- 导航收放、页头入场、留言卡片、宿舍滑轨全部改成只动透明度和位移；宿舍卡片干脆去掉逐帧重算的毛玻璃",
      "- 优化后，从原来十几帧的卡顿变成顺滑的动画，长列表也不再一顿一顿",
      "",
      "## 八、内容与后台",
      "- 管理后台七个页签：班级公告、实名审核、宿舍照片、高光时刻、首页文案与鸣谢、成员权限、用量看板",
      "- 公告正文支持 **Markdown**，编辑框上面有一排按钮，点一下插入语法，还能直接传图",
      "- 用量看板：访问量趋势、最热页面、内容与活跃、存储用量、代码规模",
      "- 账号统计：注册与新增、实名审核进度、活跃情况、角色与状态分布",
      "- 开屏公告：每次更新都会弹一次「本次更新」，同一版本每台设备只弹一次",
      "",
      "---",
      "",
      "从一行行代码到现在的样子，这个站点记录的不只是功能，更是 103 班这群人的日常。后面还会继续更新 —— 每一次，都会写在这里，也会弹在开屏上。",
    ].join("\n"),
  },
  {
    date: "2026.10.03",
    title: "103 官网正式成立",
    pinned: true,
    body: [
      "金秋十月，属于我们的数字阵地正式上线。从今天起，103 班有了自己的官网，全班的故事都写在这里。",
      "本次上线的内容：",
      "· 自由注册登录 —— 起个名字、传张头像、写一句个性签名，以后发帖不用再留名字",
      "· 留言板升级 —— 像 B 站那样逐条回复，点「回复」就地展开，关系一眼看清",
      "· IP 属地 —— 每条留言下面标注省份，都是自己人，坦坦荡荡",
      "· 服主标识 —— 班委账号带金色「服主」徽章，发布的通知自动置顶",
      "· 图片上传 —— 最多 3 张，自动压缩，传得快也看得清",
      "官网地址：jinzhong2903.me",
    ].join("\n"),
  },
  {
    date: "2026.09.29",
    title: "",
    pinned: true,
    body: "合唱比赛获得 96.95 分,位列第一。",
  },
  {
    date: "2026.09.25",
    title: "",
    pinned: false,
    body: "素养 103 第二帝国建立,何易航政府覆灭,金楚涵皈依第二帝国。",
  },
];

const DEFAULT_STUDENTS = [];

const DEFAULT_DORMS = [
  {
    number: "311",
    nick: "皇家园区",
    members: [],
    photos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `assets/images/dorm/311/${n}.jpg`),
  },
  {
    number: "312",
    nick: "大诚酒店",
    members: [],
    photos: [1, 2].map((n) => `assets/images/dorm/312/${n}.jpg`),
  },
  { number: "409", nick: "", members: [], photos: [] },
  {
    number: "410",
    nick: "金楚涵教总部",
    members: [],
    photos: [1, 2, 3].map((n) => `assets/images/dorm/410/${n}.jpg`),
  },
  {
    number: "411",
    nick: "法兰西室联盟",
    members: [],
    photos: [1, 2, 3, 4].map((n) => `assets/images/dorm/411/${n}.jpg`),
  },
  {
    number: "412",
    nick: "",
    members: [],
    photos: [1, 2, 3, 4, 5].map((n) => `assets/images/dorm/412/${n}.jpg`),
  },
];

const DEFAULT_MOMENTS = {
  groups: [
    {
      title: "高光时刻",
      en: "Highlights",
      photos: Array.from({ length: 13 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return { src: `assets/images/albums/choir-${n}.jpg`, caption: `合唱比赛 · ${n}` };
      }),
    },
    {
      title: "天桥文化",
      en: "Overpass",
      photos: [{ src: "assets/images/albums/bridge-01.jpg", caption: "天桥文化 · 01" }],
    },
  ],
  videos: [
    { src: "assets/videos/parade.mp4", caption: "片段一 · 时长 04:31" },
    { src: "assets/videos/parade-2.mp4", caption: "片段二 · 时长 00:30" },
  ],
};

export const DEFAULT_CONTENT = {
  site: DEFAULT_SITE,
  announcements: DEFAULT_ANNOUNCEMENTS,
  students: DEFAULT_STUDENTS,
  dorms: DEFAULT_DORMS,
  moments: DEFAULT_MOMENTS,
};

/* ============================================================
   归一化:只收我们认识的字段,垃圾数据进不了库
   ============================================================ */

function str(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function arr(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function normPhoto(v) {
  if (typeof v === "string") return { src: str(v, 300), caption: "" };
  return { src: str(v && v.src, 300), caption: str(v && v.caption, 80) };
}

function normSite(v) {
  const o = v && typeof v === "object" ? v : {};
  return {
    heroKicker: str(o.heroKicker, 60) || DEFAULT_SITE.heroKicker,
    heroTitle: str(o.heroTitle, 24) || DEFAULT_SITE.heroTitle,
    heroTitleSuffix: str(o.heroTitleSuffix, 8),
    heroTagline: str(o.heroTagline, 80),
    heroYear: str(o.heroYear, 8),
    studentsLede: str(o.studentsLede, 60),
    momentsNote: str(o.momentsNote, 200),
    footerItems: arr(o.footerItems, 8)
      .map((s) => str(s, 60))
      .filter(Boolean),
    thanksTitle: str(o.thanksTitle, 20) || DEFAULT_SITE.thanksTitle,
    thanksName: str(o.thanksName, 60),
  };
}

function normAnnouncements(v) {
  return arr(v, 200)
    .map((a) => ({
      date: str(a && a.date, 20),
      title: str(a && a.title, 60),
      body: str(a && a.body, 6000),
      pinned: !!(a && a.pinned),
    }))
    .filter((a) => a.date || a.title || a.body);
}

function normStudents(v) {
  return arr(v, 200)
    .map((s) => ({
      name: str(s && s.name, 20),
      tag: str(s && s.tag, 24),
      avatar: str(s && s.avatar, 300),
    }))
    .filter((s) => s.name);
}

function normDorms(v) {
  return arr(v, 80)
    .map((d) => ({
      number: str(d && d.number, 12),
      nick: str(d && d.nick, 24),
      members: arr(d && d.members, 30)
        .map((m) => str(m, 20))
        .filter(Boolean),
      photos: arr(d && d.photos, 200)
        .map((p) => str(p, 300))
        .filter(Boolean),
    }))
    .filter((d) => d.number);
}

function normMoments(v) {
  const o = v && typeof v === "object" ? v : {};
  return {
    groups: arr(o.groups, 30).map((g) => ({
      title: str(g && g.title, 40),
      en: str(g && g.en, 40),
      photos: arr(g && g.photos, 200).map(normPhoto).filter((p) => p.src),
    })),
    videos: arr(o.videos, 30)
      .map((x) => ({ src: str(x && x.src, 300), caption: str(x && x.caption, 80) }))
      .filter((x) => x.src),
  };
}

const NORMALIZERS = {
  site: normSite,
  announcements: normAnnouncements,
  students: normStudents,
  dorms: normDorms,
  moments: normMoments,
};

/* 校验并归一化一个板块;key 不认识或体积超标就抛错 */
export function normalizeContent(key, value) {
  const fn = NORMALIZERS[key];
  if (!fn) throw new Error("不认识的板块：" + key);
  const out = fn(value);
  const text = JSON.stringify(out);
  if (text.length > MAX_VALUE_BYTES) throw new Error("这个板块的内容太大了，精简一下再存");
  return out;
}

/* ============================================================
   建表 + 首次灌入默认内容(同一个 isolate 内只跑一次)
   ============================================================ */

let contentReady = null;

/* 一次性内容升级:
   content 表是 INSERT OR IGNORE 灌默认值的,光改 DEFAULT_ANNOUNCEMENTS 不会动到
   已经在库里的那份公告。这里用一个 seed 标记做闸门 —— 只有标记对不上时才把
   announcements 覆盖成最新默认值,写完标记就再也不碰,以后在后台改公告不会被冲掉。
   注意:标记值定下来就别再改,改了会再覆盖一次公告。 */
const CONTENT_SEED = "2026-10-05-announcements-overview";

async function upgradeContentOnce(db) {
  const row = await db.prepare("SELECT value FROM content WHERE key = 'seed'").first();
  if (row && row.value === CONTENT_SEED) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO content (key, value, updated_at) VALUES ('announcements', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify(DEFAULT_ANNOUNCEMENTS), now)
    .run();
  await db
    .prepare(
      `INSERT INTO content (key, value, updated_at) VALUES ('seed', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(CONTENT_SEED, now)
    .run();
}

/* 一次性换域名:库里已有的内容还带着旧站地址(pages.dev)。
   跟公告升级分开打标记 —— 只把含旧地址的那几行里的字符串换掉,
   不覆盖任何在后台改过的内容,换完写标记就不再执行 */
const DOMAIN_SEED = "2026-10-06-domain-me";
const OLD_HOST = "jinzhong2903.pages.dev";
const NEW_HOST = "jinzhong2903.me";

async function migrateDomainOnce(db) {
  const row = await db.prepare("SELECT value FROM content WHERE key = 'seed_domain'").first();
  if (row && row.value === DOMAIN_SEED) return;
  await db
    .prepare("UPDATE content SET value = REPLACE(value, ?, ?) WHERE value LIKE ?")
    .bind(OLD_HOST, NEW_HOST, "%" + OLD_HOST + "%")
    .run();
  await db
    .prepare(
      `INSERT INTO content (key, value, updated_at) VALUES ('seed_domain', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(DOMAIN_SEED, Date.now())
    .run();
}

export function ensureContent(db) {
  if (!contentReady) {
    contentReady = (async () => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS content (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL,
             updated_at INTEGER NOT NULL
           )`
        )
        .run();
      const now = Date.now();
      for (const key of CONTENT_KEYS) {
        await db
          .prepare("INSERT OR IGNORE INTO content (key, value, updated_at) VALUES (?, ?, ?)")
          .bind(key, JSON.stringify(DEFAULT_CONTENT[key]), now)
          .run();
      }
      await upgradeContentOnce(db);
      await migrateDomainOnce(db);
    })().catch((err) => {
      contentReady = null; // 失败下次重来
      throw err;
    });
  }
  return contentReady;
}

/* 读全部内容;任何一块缺失(或表被清空)就用默认值兜底,页面永远不空白 */
export async function readAllContent(db) {
  const { results } = await db.prepare("SELECT key, value FROM content").all();
  const map = new Map((results || []).map((r) => [r.key, r.value]));
  const out = {};
  for (const key of CONTENT_KEYS) {
    let parsed = null;
    try {
      parsed = JSON.parse(map.get(key));
    } catch (e) {
      parsed = null;
    }
    out[key] = parsed == null ? DEFAULT_CONTENT[key] : parsed;
  }
  return out;
}

export async function writeContent(db, key, value) {
  const clean = normalizeContent(key, value);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO content (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, JSON.stringify(clean), now)
    .run();
  return { key, value: clean, updated_at: now };
}
