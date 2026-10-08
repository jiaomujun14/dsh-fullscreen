/**
 * probe-page-manifest.mjs —— 只读探针：看正在运行的 DSH 宿主给页面的启动清单里
 * 有哪些插件客户端 bundle，以及它们的 URL 形状。
 *
 * 目的：确认 profile 的 insert 行 `dsh-fullscreen` 是否已被当前进程加载
 * （预期：没有，因为那一行是在插件包还没落盘时加进去的，需要重启才生效），
 * 并顺便弄清 `/plugins/<id>/client.js` 之外还有什么前缀（此前直接 GET 该路径 403）。
 *
 * 输出保持有界：只打印状态码、HTML 长度、去重后的插件 URL（最多 40 条）。
 */
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:43120';

const response = await fetch(`${BASE}/`);
const html = await response.text();
console.log(`index ${response.status} len=${html.length}`);

const urlPattern = /[^"'\s<>()\\]*plugins\/[^"'\s<>()\\]*/g;
const refs = [...new Set([...html.matchAll(urlPattern)].map((match) => match[0]))];
console.log(`plugin url refs: ${refs.length}`);
for (const ref of refs.slice(0, 40)) console.log(`  ${ref}`);

const ids = [...new Set([...html.matchAll(/[-@a-z0-9.]+\/client\.js/g)].map((match) => match[0]))];
console.log(`client.js refs: ${ids.length}`);
for (const id of ids.slice(0, 40)) console.log(`  ${id}`);

for (const needle of ['dsh-fullscreen', 'boot-animation', '__DSH_BOOT__']) {
  const count = html.split(needle).length - 1;
  console.log(`contains ${needle}: ${count}`);
}
