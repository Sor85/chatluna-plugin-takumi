# Agent Note: Takumi 渲染服务

Status: implemented

## Problem

多个 ChatLuna 插件（bilibili-videolink-card、impart、mc-toolbox、meme-generator）各自内置 Takumi Renderer 和同一批字体。同时启用时字体与原生 Renderer 常驻多份，渲染互相争抢 CPU，依赖版本各自漂移。

## Decision

- 以 Cordis 4 Service 提供 `ctx.takumi`（`src/service.ts`），整个进程只有一个 Renderer 和一份字体（Noto Sans SC、JP、KR 与 DejaVu Sans），字体按需加载（见下）。`fontFamilyFor(language)` 把对应语言的 CJK 字体排在最前，使共用汉字采用该语言字形；`fontFamily` 等同 `zh`。
- 接口为 `render(source, options)` 与 `measure(source, options)`：`source` 是 HTML 字符串或节点树，分别返回图片 Buffer 与布局。不暴露 `Renderer`，再导出节点类型，调用方不依赖 `@takumi-rs/*`。
- HTML 输入经 `parseHtml`：先提取全部 `<style>`（`fromHtml` 丢弃 `<head>` 内样式，完整文档会失去 CSS），再在节点树上解码实体（`decodeNode`）。调用方负责先转义外部文本。
- 服务不发网络请求：远程图片与 emoji 经调用方 `fetch` 下载，失败或缺省时用透明占位。可信域名与大小限制留在各调用方。
- 字体按需加载：建立 Renderer 时只按 fontsource 的 `unicode.json` 建分片索引并加载无字符范围的 DejaVu；每次渲染或测量前加载文本字符所在的全部分片，字体加载串行执行。实测常见文本下字体相关内存约 34 MB，全部加载约 59 MB；首次遇到新字符的那次渲染多约 30–50 ms。
- `concurrency`（默认 2，范围 1–16）只限制 `Renderer.render` 与 `measure`；释放名额时唤醒全部等待者重新检查。渲染同时响应调用方 `signal` 与服务卸载。

## Alternatives considered

- 共享 npm 库：去重代码但不省内存。
- 服务内统一下载图片：无法知道各插件的可信域名与限额，拒绝。
- 暴露动画等其他 Takumi 接口：目前没有调用方需要。`measure` 因 meme-generator 列表分页需要而提供。
- 必需服务与可选服务：图片是主要输出的插件（B 站卡片）声明必需；能回退文字的插件（impart、mc-toolbox、meme-generator）声明可选并在调用时 `ctx.get`，避免未启用本插件时整个插件停用。
- 只加载回退列表中第一个覆盖字符的分片：Takumi 按文本段选字体，例如「한국어」整段选韩文字体，而「국」只加载了简体分片时显示方框，与全量加载结果不一致，拒绝。

## Consequences

- 依赖本服务的插件需要用户同时安装本插件。
- 升级 Takumi 或字体只改本插件；新增字体会影响所有调用方的内存。
- 已加载的字体分片在服务运行期间常驻，内存随出现过的字符缓慢增长，上限为全部字体。
