/**
 * 快递单号的**查询路径**与**快递商识别**。
 *
 * 两件事放在同一个文件，是因为它们本来就是同一件事的两半：
 * "这是谁家的单"决定了"该去哪儿查"，而"能查"才是识别的意义 ——
 * 认出来却没地方点，界面上就只是多了一个好看的标签。
 *
 * 刻意**不接第三方轨迹 API**（快递100 企业版、快递鸟那种）：
 * 那要联网、要密钥、要按量付费，而这个应用的数据只在本机、离线可用。
 * 这里的做法是"给出正确的查询入口"：认出快递商 → 拼出对应的查询页 →
 * 一键在系统浏览器打开 / 复制链接带走。用户自己选择在哪查，
 * 也就不需要把密钥交给我们。
 */

/* ------------------------------------------------------------------ */
/* 快递商                                                              */
/* ------------------------------------------------------------------ */

export interface CourierRule {
  re: RegExp;
  /**
   * 是不是**强特征**。
   *
   * 强特征 = 字母前缀这类不会认错的（SF… 只可能是顺丰）；
   * 弱特征 = "12 位纯数字"这类光看形状会撞车的（顺丰、中通、圆通都可能是）。
   * 分两档是为了排序：强命中一定排在弱命中前面，
   * 而不是让"列表里谁在上面"这种偶然顺序决定用户看到什么。
   */
  strong: boolean;
}

export interface Courier {
  /** 内部代号，**落库用这个**（存它而不是存中文名：名字以后可能改，代号不会） */
  code: string;
  name: string;
  /** 短名：表格徽标上只有几个字的空间 */
  short: string;
  /** 快递100 的 com 参数值。空串 = 不指定（让它自己认） */
  kuaidi100: string;
  /**
   * 官网查询页模板，`{no}` 替换成单号。
   *
   * null 不是"没做"，是**没有可直接带单号的官网查询页**：
   * 不少快递公司的官网查询要登录、或是 POST 表单，拼一个看着像的 URL
   * 只会让人点到 404 —— 那就比不提供还糟。这几家会自动退回聚合查询。
   */
  officialUrl: string | null;
  rules: CourierRule[];
}

/** 强规则：字母前缀，认出来就不会是别家 */
const s = (src: string): CourierRule => ({ re: new RegExp(src, "i"), strong: true });
/** 弱规则：长度 + 数字前缀，会撞车，只在没有强命中时才作数 */
const w = (src: string): CourierRule => ({ re: new RegExp(src, "i"), strong: false });

/**
 * 快递商清单。
 *
 * 顺序即优先级：同样是弱命中时，越常用的排越前。
 * 只收国内电商场景里真会遇到的那批 —— 每多一家就多一处"认错了"的可能，
 * 认错的代价比认不出来高得多。
 */
export const COURIERS: Courier[] = [
  {
    code: "sf",
    name: "顺丰速运",
    short: "顺丰",
    kuaidi100: "shunfeng",
    officialUrl:
      "https://www.sf-express.com/cn/sc/dynamic_function/waybill/#search/bill-number/{no}",
    // 只认 15 位纯数字，不认 12 位：12 位纯数字是中通、圆通、韵达的形状，
    // 硬按"顺丰也常常是 12 位"把每一串 12 位数字都安成顺丰，代价是每次都猜错。
    // 认不出来的补救有两条（下拉手选 + 快递100 自己再认一次），猜错却没人兜。
    rules: [s("^SF\\d{12,15}$"), w("^\\d{15}$")],
  },
  {
    code: "jd",
    name: "京东物流",
    short: "京东",
    kuaidi100: "jd",
    officialUrl: null,
    rules: [s("^JDV?\\d{10,20}$")],
  },
  {
    code: "yt",
    name: "圆通速递",
    short: "圆通",
    kuaidi100: "yuantong",
    officialUrl: null,
    rules: [s("^YT\\d{10,13}$"), w("^D\\d{15}$")],
  },
  {
    code: "zt",
    name: "中通快递",
    short: "中通",
    kuaidi100: "zhongtong",
    officialUrl: null,
    rules: [s("^ZT\\d{11,15}$"), w("^(68|78|66)\\d{10}$")],
  },
  {
    code: "yd",
    name: "韵达速递",
    short: "韵达",
    kuaidi100: "yunda",
    officialUrl: null,
    rules: [s("^YD\\d{10,13}$"), w("^(31|43|46|47)\\d{11}$")],
  },
  {
    code: "sto",
    name: "申通快递",
    short: "申通",
    kuaidi100: "shentong",
    officialUrl: null,
    rules: [s("^STO\\d{10,13}$"), w("^(77|88|55)\\d{10}$")],
  },
  {
    code: "jt",
    name: "极兔速递",
    short: "极兔",
    kuaidi100: "jtexpress",
    officialUrl: null,
    rules: [s("^JT\\d{11,15}$")],
  },
  {
    code: "db",
    name: "德邦快递",
    short: "德邦",
    kuaidi100: "debangkuaidi",
    officialUrl: null,
    rules: [s("^DPK\\d{8,12}$"), s("^DPL\\d{8,12}$"), s("^DB\\d{8,12}$"), w("^\\d{8}$")],
  },
  {
    code: "bs",
    name: "百世快递",
    short: "百世",
    kuaidi100: "huitongkuaidi",
    officialUrl: null,
    rules: [w("^[ABD]\\d{11,13}$")],
  },
  {
    code: "ems",
    name: "EMS",
    short: "EMS",
    kuaidi100: "ems",
    officialUrl: null,
    // 国际/挂号信是「两位字母 + 9 位数字 + 两位字母」，一眼能认出；
    // 国内 EMS 是 1 开头的 13 位，形状上和邮政包裹分不开，所以算弱
    rules: [s("^[A-Z]{2}\\d{9}[A-Z]{2}$"), w("^1\\d{12}$")],
  },
  {
    code: "yz",
    name: "邮政快递包裹",
    short: "邮政",
    kuaidi100: "youzhengguonei",
    officialUrl: null,
    rules: [w("^9\\d{12}$")],
  },
  {
    code: "zjs",
    name: "宅急送",
    short: "宅急送",
    kuaidi100: "zhaijisong",
    officialUrl: null,
    rules: [s("^ZJS\\d{10,13}$")],
  },
  {
    code: "tt",
    name: "天天快递",
    short: "天天",
    kuaidi100: "tiantian",
    officialUrl: null,
    rules: [s("^TT\\d{10,13}$")],
  },
  {
    code: "ky",
    name: "跨越速运",
    short: "跨越",
    kuaidi100: "kuayue",
    officialUrl: null,
    rules: [s("^KY\\d{10,13}$")],
  },
];

const BY_CODE = new Map(COURIERS.map((c) => [c.code, c]));

export function courier(code: string | undefined | null): Courier | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code);
}

export function courierName(code: string | undefined | null): string {
  return courier(code)?.name ?? "";
}

/* ------------------------------------------------------------------ */
/* 识别                                                                */
/* ------------------------------------------------------------------ */

export interface CourierGuess {
  /** 最可能是谁。空串 = 认不出来 */
  code: string;
  /** 是否强特征命中（认错了的概率很低） */
  certain: boolean;
  /** 所有候选，按置信度排序。撞车时让人自己挑 */
  candidates: string[];
}

/**
 * 从单号猜快递商。
 *
 * 归一化：空格与连字符先去掉 —— 单号是从网页、短信、Excel 里粘过来的，
 * 带空格和横杠是常态（"SF 1234 5678"），不处理的话一条都认不出。
 */
export function detectCourier(no: string | undefined | null): CourierGuess | null {
  const n = (no ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!n) return null;

  const strong: string[] = [];
  const weak: string[] = [];
  for (const c of COURIERS) {
    for (const r of c.rules) {
      if (!r.re.test(n)) continue;
      (r.strong ? strong : weak).push(c.code);
      break;
    }
  }
  const candidates: string[] = [];
  for (const code of [...strong, ...weak]) {
    if (!candidates.includes(code)) candidates.push(code);
  }
  if (!candidates.length) return null;
  return { code: candidates[0], certain: strong.length > 0, candidates };
}

/**
 * 这张单上**实际生效**的快递商：库里指定了就用指定的，否则自动识别。
 *
 * 存"自动"而不是"识别结果"是有意的：识别规则以后会补、会修，
 * 把当年的猜测结果冻进库里，等于让老数据永远停在旧规则上。
 */
export function courierCodeOf(no: string, stored: string | undefined | null): string {
  const fixed = (stored ?? "").trim();
  if (fixed) return fixed;
  return detectCourier(no)?.code ?? "";
}

/* ------------------------------------------------------------------ */
/* 查询路径                                                            */
/* ------------------------------------------------------------------ */

/**
 * 查询渠道。
 *
 * 之所以要可配，不是因为"多几个按钮好看"：同一张单在不同人手上有不同去处 ——
 * 跟平台单的人要菜鸟（淘宝单在菜鸟里最全），跟线下单的人要官网，
 * 其他大多数时候快递100 覆盖最广。写死一个等于让另两拨人每次都手动改网址。
 */
export type TrackChannel = "kuaidi100" | "cainiao" | "official";

export const TRACK_CHANNELS: Array<{
  value: TrackChannel;
  label: string;
  hint: string;
}> = [
  {
    value: "kuaidi100",
    label: "快递100",
    hint: "覆盖最广，认出快递商时自动带上对应通道",
  },
  {
    value: "cainiao",
    label: "菜鸟全球",
    hint: "平台单（淘宝/天猫）在菜鸟里轨迹最全",
  },
  {
    value: "official",
    label: "快递商官网",
    hint: "少数几家有可直接带单号的官网查询页，其余自动退回快递100",
  },
];

export function parseTrackChannel(raw: string | undefined): TrackChannel {
  return TRACK_CHANNELS.some((c) => c.value === raw) ? (raw as TrackChannel) : "kuaidi100";
}

export function channelLabel(channel: TrackChannel): string {
  return TRACK_CHANNELS.find((c) => c.value === channel)?.label ?? "快递100";
}

/** 拼查询链接。给不出链接（没有单号 / 这家没有官网查询页）返回 null */
export function trackUrl(
  no: string | undefined | null,
  code: string | undefined | null,
  channel: TrackChannel,
): string | null {
  const n = (no ?? "").trim();
  if (!n) return null;
  const num = encodeURIComponent(n);

  if (channel === "cainiao") {
    return `https://global.cainiao.com/global/detail.html?mailNos=${num}&lang=zh-CN`;
  }
  if (channel === "official") {
    const url = courier(code)?.officialUrl;
    return url ? url.replace("{no}", num) : null;
  }
  // 认不出快递商时不带 com：快递100 自己也会认一次，
  // 带一个瞎猜的 com 反而会让它查错（"查不到这个单"比"自动认成别家"更容易被察觉）
  const com = courier(code)?.kuaidi100;
  return com
    ? `https://www.kuaidi100.com/chaxun?com=${encodeURIComponent(com)}&nu=${num}`
    : `https://www.kuaidi100.com/chaxun?nu=${num}`;
}

export interface TrackLink {
  url: string;
  /** 实际用的渠道（可能与要的不一样，见 fellBack） */
  channel: TrackChannel;
  /** 想用官网但这家没有，退回聚合查询了 */
  fellBack: boolean;
}

/** 取一条**一定能用**的查询链接：官网渠道在这家没有时自动退回快递100 */
export function resolveTrack(
  no: string | undefined | null,
  code: string | undefined | null,
  channel: TrackChannel,
): TrackLink | null {
  const direct = trackUrl(no, code, channel);
  if (direct) return { url: direct, channel, fellBack: false };
  if (channel !== "official") return null;
  const fb = trackUrl(no, code, "kuaidi100");
  return fb ? { url: fb, channel: "kuaidi100", fellBack: true } : null;
}

/**
 * 打开查询链接。
 *
 * 两条路径是因为宿主不止一个：桌面端（WebView2）里 window.open 会被宿主
 * 接走、用系统默认浏览器打开 —— 那正是我们要的（查件是要登录、要打单的，
 * 不该挤在应用里那个没有地址栏的窗口里）；浏览器里则可能被弹窗拦截，
 * 那种情况下退回 <a target=_blank> 的点击（同样是用户手势触发，拦不住）。
 */
export function openTrackUrl(url: string): boolean {
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win) {
      // 新窗口理论上拿不到我们的 window（noopener），但老浏览器不认这个参数
      try {
        win.opener = null;
      } catch {
        /* 跨域写 opener 会抛，忽略即可 */
      }
      return true;
    }
  } catch {
    /* 掉到下面的兜底 */
  }
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}
