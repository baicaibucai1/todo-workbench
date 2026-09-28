/**
 * 助手的图片上传：把「用户手里的一张图」变成「模型能读的一张图」。
 *
 * ------------------------------------------------------------------
 * 为什么非得压缩，而不是把原图直接 base64 发出去
 * ------------------------------------------------------------------
 * 手机随便拍一张是 3~6MB，截图也能到 1MB。Base64 会把体积放大约 1/3，
 * 几张图加在一起就逼近各家那条**请求体上限**（DeepSeek 48MB、单图 32MB；
 * 百炼要求编码后的 Data URI ≤ 20MB）。真到了上限不是变慢，是**整次请求失败**。
 *
 * 更反直觉的是**多压也省钱**：DeepSeek 明确写了图片按尺寸折算 token、
 * 单张**上限 384 token**（约等于一张 800×800）——也就是说一张 4000×3000 的
 * 原图和一张 1280 宽的图，模型花在它上面的钱**一模一样**。既然上限如此，
 * 传超过那个尺寸的部分纯属白送。
 *
 * ------------------------------------------------------------------
 * 为什么这里只认 File / Blob，不认本机路径
 * ------------------------------------------------------------------
 * 桌面端本来可以用文件对话框拿一串路径再去读字节，但 `src-tauri/capabilities`
 * 里的 `fs:scope` 只放开了 `$APPDATA/**` 与 `$RESOURCE/**` —— 用户想选的图
 * 大半在桌面、下载、截图目录里，那些路径一律被挡在外面。
 * 放开 scope 是拿一张"整个磁盘都能读"的权限换一个小功能，不划算。
 *
 * 而 **`<input type="file">`、剪贴板、拖拽这三种入口给的都是 File 对象**，
 * 它自带字节、不经过文件系统、也不需要任何额外权限。项目里「导入工具」
 * 那条路走的正是同一个套路（见 settings/ToolsSection.tsx），是已经被验证过的。
 *
 * 顺带一个隐藏好处：File 生成的 `blob:` URL 与宿主同源，
 * 画到 canvas 上**不会污染画布** —— 走 asset 协议 URL 则会让
 * `toDataURL()` 直接抛 SecurityError。
 */

/** 发给模型的那份的最长边。见顶部注释：再大也不多花 token，只是更贵 */
export const SEND_MAX = 1280;
/** 界面回显用的缩略图最长边 */
export const THUMB_MAX = 320;
/** JPEG 质量。0.82 是"肉眼几乎看不出、体积掉一半"的那一档 */
const JPEG_QUALITY = 0.82;
/**
 * 单张原图的读入上限（压缩之前）。
 *
 * 超过这个大小不是"不能处理"，而是**先谢绝**：一张 40MB 的 TIFF 光是解码
 * 就能让界面卡好几秒。真有大图要发，用户会先收到一句说得清的话。
 */
export const SOURCE_MAX_BYTES = 30 * 1024 * 1024;
/**
 * 最短边的下限。
 *
 * 不是我们挑剔，是百炼那一侧明写了：宽高都要 ≥ 10px，且宽高比不超过 200:1。
 * 一张 1px 高的分隔线切图传过去会被服务端判为不合法 —— 那是整次请求 400。
 */
const MIN_SIDE = 10;
/** 极端宽高比下允许长边涨到的上限，超过就放弃这张图 */
const HARD_MAX = 4096;

/** 认得的图片后缀（用来兜 `file.type` 为空的情况，某些系统读出来是空串） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;

/** 一条对话消息里附带的一张图 */
export interface AgentImage {
  id: string;
  /** 原文件名。模型看不到内容时至少有这个名字可以提 */
  name: string;
  /** 发给模型的那份：完整 data URI（已压到 SEND_MAX） */
  dataUrl: string;
  /** 界面回显用的小图 data URI（不发给模型） */
  thumb: string;
  /** 重编码后固定为 image/jpeg —— 见下面的"透明区域"说明 */
  mime: string;
  /** 压缩后的宽高。存下来是为了落库后能算出宽高比，不必再解码一次 */
  width: number;
  height: number;
  /** dataUrl 的近似字节数。全是 ASCII，所以字符数就是字节数 */
  bytes: number;
}

/** 一张被跳过的图，以及为什么 */
export interface SkippedImage {
  name: string;
  reason: string;
}

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 把浏览器里的图片元素解码出来。
 *
 * 用 `decode()` 而不是等 `onload`：后者在部分实现里会早于解码完成触发，
 * 那时画到 canvas 上得到的是一张**空白图** —— 症状是"模型说图里什么都没有"，
 * 很难往加载时机上想。图库里的 makeThumb 用的也是这个写法。
 */
async function decodeImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/**
 * 算出压缩后的尺寸。
 *
 * 两步走，因为两个约束可能打架：
 *   1. 先把长边压到 SEND_MAX；
 *   2. 压完之后如果短边 < MIN_SIDE（极端细长的图），反过来实现"短边补到
 *      MIN_SIDE" —— 这时长边可能超过 SEND_MAX，但只要不超过 HARD_MAX 就认。
 *
 * 第 2 步不是洁癖：一张 2000×8 的长条图，按比例压到 1280 宽之后只剩 5px 高，
 * 正好掉进百炼那条"宽高 < 10px 不合法"里，结果是**整次请求**被拒。
 */
function fitSize(
  w: number,
  h: number,
): { width: number; height: number } | { reason: string } {
  if (!w || !h) return { reason: "读不出图片尺寸（文件可能已损坏）" };
  if (w / h > 200 || h / w > 200) {
    return { reason: "这张图太细长了 —— 宽高比超过 200:1，模型那边不接受" };
  }

  let scale = Math.min(1, SEND_MAX / Math.max(w, h));
  let width = Math.max(1, Math.round(w * scale));
  let height = Math.max(1, Math.round(h * scale));

  if (Math.min(width, height) < MIN_SIDE) {
    scale = MIN_SIDE / Math.min(w, h);
    width = Math.max(MIN_SIDE, Math.round(w * scale));
    height = Math.max(MIN_SIDE, Math.round(h * scale));
    if (Math.max(width, height) > HARD_MAX) {
      return { reason: "这张图过于细长，压缩后仍超出模型能接受的尺寸范围" };
    }
  }
  return { width, height };
}

/**
 * 画一张 canvas。
 *
 * 底色**必须铺白**：截图、图标、带通道的 PNG 大多是透明背景，
 * 直接转 JPEG 的话透明区会被填成**黑色** —— 用户传一张白底黑字的截图进去，
 * 模型看到的是黑底黑字。这类"看不清"最难排查，因为发送方觉得图是好的。
 */
function render(img: HTMLImageElement, width: number, height: number): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // 写关键字而不是写十六进制：这里要的是"纸"的概念，跟主题色无关，
  // 写成 #ffffff 会让人误以为它是某个需要跟主题同步的令牌
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/**
 * 出一张缩略图的 data URL。失败返回空串，由调用方回退到用大图。
 *
 * 从已经画好的大图 canvas 二次下采样，而不是从原图重新解码：
 * 少一次解码、而且与原图完全一致（不会出现"预览和发出去的不是同一张"）。
 */
function thumbUrl(w: number, h: number, source: HTMLCanvasElement): string {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // 缩略图比发给模型的那份压得更狠：它要跟几十条消息一起常驻内存与库里
  return canvas.toDataURL("image/jpeg", 0.7);
}

/**
 * 把一套来源文件变成对话里能带的图。
 *
 * **一张坏图不影响其它图** —— 五张里有一张读不出来，返回四张加一条说明。
 * 反过来（整批失败）会让人觉得"这个功能时灵时不灵"，而实际上坏的是其中一张。
 */
export async function prepareImages(
  files: Array<{ name: string; blob: Blob }>,
): Promise<{ images: AgentImage[]; skipped: SkippedImage[] }> {
  const images: AgentImage[] = [];
  const skipped: SkippedImage[] = [];

  for (const file of files) {
    const name = file.name || "未命名图片";
    const looksLikeImage = file.blob.type.startsWith("image/") || IMAGE_EXT.test(name);
    if (!looksLikeImage) {
      skipped.push({ name, reason: "不是图片文件" });
      continue;
    }
    if (file.blob.size > SOURCE_MAX_BYTES) {
      skipped.push({ name, reason: `原图超过 ${Math.round(SOURCE_MAX_BYTES / 1024 / 1024)}MB` });
      continue;
    }

    const url = URL.createObjectURL(file.blob);
    try {
      const img = await decodeImage(url);
      const size = fitSize(img.naturalWidth, img.naturalHeight);
      if ("reason" in size) {
        skipped.push({ name, reason: size.reason });
        continue;
      }

      const full = render(img, size.width, size.height);
      if (!full) {
        skipped.push({ name, reason: "浏览器没能创建画布（可能是内存不足）" });
        continue;
      }

      // 缩略图只画给界面看，画不出来也不该让**这一整张图**失败 ——
      // 那种失败最难认：用户看到的是"我传的图不见了"，而图其实只是没预览图
      const thumb = thumbUrl(size.width, size.height, full);

      const dataUrl = full.toDataURL("image/jpeg", JPEG_QUALITY);
      images.push({
        id: uid(),
        name,
        dataUrl,
        thumb: thumb || dataUrl,
        mime: "image/jpeg",
        width: size.width,
        height: size.height,
        bytes: dataUrl.length,
      });
    } catch {
      // decode() 抛错基本就这两种：文件根本不是图片（后缀骗人）、或者已损坏
      skipped.push({ name, reason: "打不开这个文件（可能已损坏，或者不是真图片）" });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { images, skipped };
}

/**
 * 从拖拽 / 粘贴事件里挑出图片文件。
 *
 * 剪贴板的坑在于它**混合搬运**：从网页里复制一段图文，items 里同时有
 * `text/html`、`text/plain` 和 `image/png`。若把整份 files 都当图处理，
 * 用户粘贴一段文字会粘出一张空图。所以只挑 kind==="file" 且类型是图的。
 */
export function imageFilesFrom(dataTransfer: DataTransfer | null): Array<{ name: string; blob: Blob }> {
  if (!dataTransfer) return [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  const out: Array<{ name: string; blob: Blob }> = [];

  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) {
      out.push({ name: file.name || guessName(file.type), blob: file });
    }
  }

  // Safari 的部分版本不给 items，只给 files —— 兜底走一遍同样的过滤
  if (!out.length && dataTransfer.files?.length) {
    for (const file of [...dataTransfer.files]) {
      if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) {
        out.push({ name: file.name || guessName(file.type), blob: file });
      }
    }
  }
  return out;
}

/**
 * 粘贴出来的图没有文件名（它的"文件名"在剪贴板里叫 image.png 或直接为空）。
 * 给一个能认出来的名字：落库之后这条消息显示成「截图 image.png」，
 * 比「未命名图片」强 —— 用户一眼能认出这是自己刚粘的那张。
 */
function guessName(mime: string): string {
  const sub = mime.split("/")[1]?.split("+")[0] ?? "";
  return sub ? `粘贴的图片.${sub}` : "粘贴的图片";
}

/** 一堆图加起来多大（字节）。给"这一轮还能不能再加图"的判断用 */
export function totalBytes(images: AgentImage[]): number {
  return images.reduce((n, i) => n + i.bytes, 0);
}
