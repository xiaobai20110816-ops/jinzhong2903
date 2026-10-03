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
      "官网地址：jinzhong2903.pages.dev",
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
