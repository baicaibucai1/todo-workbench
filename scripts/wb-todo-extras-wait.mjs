/** 一次性脚本：todo-extras 里关联候选池的等待方式改成"等它自己就绪" */
import fs from "node:fs";

const FILE = "tests/todo-extras.mjs";
let s = fs.readFileSync(FILE, "utf8");
let n = 0;
function rep(name, oldStr, newStr, expect = 1) {
  const hits = s.split(oldStr).length - 1;
  if (hits !== expect) throw new Error(`${name}: 期望 ${expect} 次，命中 ${hits} 次`);
  s = s.replace(oldStr, newStr);
  n++;
  console.log(`✓ ${name}`);
}

rep(
  "加 waitLinkOptions",
  `/** 提醒扫描是 30 秒一轮，测试里用"窗口重新可见"这条即时通道触发 */`,
  `/**
 * 等关联候选池真的就绪。
 *
 * 候选池是**聚焦搜索框时**才去取的（见 TaskLinkPool 里的说明），异步的。
 * 原来填完搜索框固定 sleep 一下就数 \`[data-link-option]\` —— 机器忙的时候
 * 那点时间不够，表现为"搜索能找到候选任务 count=0"，单跑绿、连跑红。
 * 这里改成等它自己从 loading 变成数字，不猜时长。
 */
async function waitLinkOptions() {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("[data-link-pool]");
        return !!el && el.getAttribute("data-link-pool") !== "loading";
      },
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.locator("[data-link-option]").first().waitFor({ timeout: 15000 }).catch(() => {});
}

/** 提醒扫描是 30 秒一轮，测试里用"窗口重新可见"这条即时通道触发 */`,
);

rep(
  "第 3 节等待方式",
  `await page.locator("[data-link-search]").fill("关联目标");
await page.waitForTimeout(400);
const optionCount = await page.locator("[data-link-option]").count();`,
  `await page.locator("[data-link-search]").fill("关联目标");
await waitLinkOptions();
const optionCount = await page.locator("[data-link-option]").count();`,
);

rep(
  "第 3b 节等待方式",
  `await page.locator("[data-link-search]").fill("刚建好就要关联");
await page.waitForTimeout(800);
const freshHits = await page.locator("[data-link-option]").count();`,
  `await page.locator("[data-link-search]").fill("刚建好就要关联");
await waitLinkOptions();
const freshHits = await page.locator("[data-link-option]").count();`,
);

fs.writeFileSync(FILE, s);
console.log(`共 ${n} 处`);
