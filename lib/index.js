/**
 * dsh-fullscreen —— host half（宿主半区）.
 *
 * 本文件是**空壳**。插件真正的工作全部发生在浏览器半区（lib/client.js），
 * 由 package.json 里的 `dsh.client` 清单加载，在渲染进程内调用 HTML
 * Fullscreen API 把 Electron 的 BrowserWindow 切到操作系统级全屏。
 *
 * 既然什么也不做，为什么还要一个 host row？因为 DSH 的 ClientModuleRegistry
 * 只扫描**已加载的 Loader 条目**（它订阅 `internal/plugin` 事件，拿到
 * `fiber.entry.options.name` 之后才去读那个包的 dsh.client 声明），而条目来自
 * bundle patch。没有 cordis.patch.yml 里那行 `insert`，package.json 中的
 * `dsh.client` 永远不会被发现，浏览器半区也就不会被送进页面。
 *
 * 本插件不注册模型可见的工具、不加提示词、不开 HTTP 路由，因此不需要
 * `webServer` 之类的服务，inject 为空数组。
 */

/** 无必需服务：宿主半区不参与任何工作。 */
export const inject = [];

/**
 * 装载宿主半区。只写一行日志，方便在宿主日志里确认 bundle 已被加载。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  const logger = ctx === undefined || ctx === null ? undefined : ctx.logger;
  if (logger !== undefined && logger !== null && typeof logger.info === "function") {
    logger.info("[dsh-fullscreen] bundle loaded; the browser half owns the window state");
  }
}

export default { inject, apply };
