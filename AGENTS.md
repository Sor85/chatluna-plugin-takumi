# AGENTS.md — chatluna-plugin-takumi

ChatLuna v2 的 Takumi 图片渲染服务插件，提供 `ctx.takumi`，让多个插件共享同一份字体与 Renderer。Cordis 4 Service。MIT 协议。

## 开发与验证

- 当前目录是唯一源码，单向同步到 ChatLuna v2 的 `external/takumi`；禁止直接编辑运行副本。
- 源码不安装依赖、不生成锁文件。执行 `node scripts/sync-to-v2.mjs --once`；宿主默认 `../../chatluna-v2-mirror`，可通过 `CHATLUNA_V2_ROOT` 指定。
- 首次同步或依赖变化后在宿主执行 `yarn install`；构建执行 `yarn yakumo build takumi`。在宿主插件目录执行 `yarn typecheck`、`yarn test`。
- 发布用 `node scripts/publish.mjs`（`--dry-run` 演练，`--otp=<验证码>` 两步验证）：要求工作区干净、提交已推送、`v<版本>` tag 不存在；发布前清空副本 `lib` 与 `tsconfig.tsbuildinfo`，`yarn pack` 后解压再 `npm publish`。
- 不自行创建分支、提交或发布。

## 约定

- 服务只做渲染，不发网络请求：远程图片和 emoji 由调用方的 `fetch` 回调下载，URL 校验与大小限制属于调用方的安全边界；失败或缺少回调时使用透明占位图，不让渲染报错。
- 跨插件接口只暴露 HTML 字符串或 Takumi 节点树、渲染/测量参数、返回的图片 Buffer 与布局，以及再导出的节点类型；不暴露 `Renderer` 实例。调用方不直接依赖 `@takumi-rs/*` 或字体包，升级 Takumi 只改本插件。
- HTML 输入经 `parseHtml` 处理：先提取所有 `<style>`（`fromHtml` 会丢弃 `<head>` 内的样式），再解析并在节点树上解码实体（`decodeNode`）。调用方构造 HTML 时必须先转义外部文本。节点树输入原样使用。
- 字体（Noto Sans SC、JP、KR 与 DejaVu Sans）整个服务只保留一份 Renderer。首次读取字体列表时只按 fontsource 的 `unicode.json` 建分片索引并加载没有字符范围的文件（DejaVu）；每次渲染或测量前加载文本中字符所在的**全部**分片（`loadFonts`），排队执行避免重复加载。不能只加载回退列表中第一个覆盖该字符的分片：Takumi 按文本段选字体，例如「한국어」整段会选韩文字体，只加载简体分片中的「국」会显示方框。测试与全量加载逐像素比对。`fontFamilyFor` 只调整 CJK 字体的先后，DejaVu 始终最后。新增字体包要同时考虑所有调用方的内存开销。
- `concurrency` 只限制 `Renderer.render` 与 `measure`，下载不占用名额；等待者在释放时全部唤醒并重新检查上限，避免被取消的等待者占住名额。
- 每次渲染同时响应调用方 `signal` 与服务卸载。
- README 面向使用者与调用方插件作者；实现决策记录在 `.agents/notes/implemented/architecture/2026-11-21-takumi-service.{zh,en}.md`。
