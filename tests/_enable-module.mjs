/**
 * e2e 里启用一个**选装模块**。
 *
 * ------------------------------------------------------------------
 * 为什么要有这个文件
 * ------------------------------------------------------------------
 * 特殊单号（v17）与图库（v18）都改成了选装：新建的库默认不带，
 * 侧边栏里根本没有入口。于是所有"进去点它的入口"的套件，开局都会红在
 * `waiting for locator('aside [data-nav="gallery"]')` 上 —— 看上去像功能炸了，
 * 其实只是没人去按那个开关。
 *
 * 所以每个依赖选装模块的套件，开头都要先把它打开。这一步**必须在套件里**，
 * 不能靠改默认值让它默认开 —— 那等于把"选装"这件事在测试里关掉了，
 * 而"默认没有入口"本身正是要验的行为之一。
 *
 * ------------------------------------------------------------------
 * 怎么开
 * ------------------------------------------------------------------
 * 走真实界面：设置 → 行为 → 选装模块 → 打开开关。
 * 故意不用 `repo.setSettings` 之类的数据层捷径 —— 那个开关是给人按的，
 * 测试也该按它一遍，顺带把"设置页里找得到它"这件事一起验了。
 *
 * 用法：
 *   import { enableModule } from "./_enable-module.mjs";
 *   await enableModule(page, "gallery");
 */

/**
 * @param page  playwright 的 page
 * @param id    模块 id（注册表里的 id，也是 data-switch="<id>-enabled" 的那一段）
 */
export async function enableModule(page, id) {
  await page.locator('aside [data-nav="settings"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-section="behavior"]').first().click();
  await page.waitForTimeout(450);

  const sw = page.locator(`[data-switch="${id}-enabled"]`);
  if ((await sw.count()) === 0) {
    throw new Error(`设置 → 行为里没有「${id}」的开关（选装模块列表是由注册表生成的）`);
  }
  if ((await sw.getAttribute("aria-checked")) !== "true") {
    await sw.click();
    await page.waitForTimeout(800);
  }
  return true;
}

/** 回到某个视图（启用模块之后人会站在设置页上，多数套件要回到列表） */
export async function gotoView(page, navKey) {
  await page.locator(`aside [data-nav="${navKey}"]`).first().click();
  await page.waitForTimeout(700);
}
