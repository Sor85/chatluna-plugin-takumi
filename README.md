# ChatLuna Takumi 渲染服务

为 ChatLuna v2 提供 `takumi` 服务，把 HTML 或 Takumi 节点树渲染为 PNG、WebP、JPEG 图片。多个插件共用同一份字体和渲染器，不启动浏览器。

## 功能

- 内置 Noto Sans SC、Noto Sans JP、Noto Sans KR 与 DejaVu Sans，覆盖中文、日文、韩文与拉丁字符。字体按需加载：渲染时只加载文本实际用到的字符分片，加载过的分片之后复用，输出与全部加载时一致。
- 可按语言选择字体顺序，让中日韩共用的汉字使用对应语言的字形。
- 可选把 emoji 替换为 Twemoji 等图片。
- 限制同时进行的渲染与测量数量，超出的任务排队。
- 本插件不发起网络请求，远程图片由调用方插件下载。

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `concurrency` | `2` | 同时渲染与测量数，范围 1–16；图片下载不占用名额 |

## 在插件中使用

在 `package.json` 中把 `chatluna-plugin-takumi` 加入 `peerDependencies`。图片是插件的必需输出时，在 `cordis.service.required` 和 `inject` 中声明 `takumi`；图片可以回退为文字时，在 `cordis.service.optional` 中声明，并在使用时通过 `ctx.get('takumi')` 获取：

```ts
import type {} from 'chatluna-plugin-takumi'

export const inject = ['takumi']

async function renderGreeting(ctx: Context, signal: AbortSignal) {
  const html = `<div style="width: 400px; font-family: ${ctx.takumi.fontFamily}, sans-serif">你好</div>`
  return ctx.takumi.render(html, {
    width: 400,
    format: 'png',
    emoji: 'twemoji',
    fetch: (url) => downloadTrustedImage(url),
    signal
  })
}
```

- `render(source, options)`：`source` 为 HTML 字符串或节点树；其余参数与 Takumi `RenderOptions` 一致（`fetchedResources` 除外）。完整 HTML 文档 `<head>` 中的 `<style>` 同样生效。
- `measure(source, options)`：参数同 `render`，只排版不出图，返回各节点的尺寸与位置（CSS 像素），可用于分页。
- `fontFamily`：以简体中文字体开头的字体列表；`fontFamilyFor('ja' | 'ko' | 'zh')` 返回以对应语言字体开头的列表，用于日文、韩文内容。
- `parseHtml(html)`：与 `render` 相同的 HTML 解析结果（节点树与样式表），可用于测试；节点类型 `Node`、`TextNode` 等也从本包导出。
- `fetch`：下载单张远程图片，返回字节。URL 校验和大小限制由调用方负责；失败或未提供时显示透明占位。
- `emoji`：emoji 图片集，生成的图片地址同样经过 `fetch`。
- HTML 中的外部文本须先做 HTML 转义，本服务在解析后的节点树上解码实体。

## 限制

- 只支持 Takumi 能解析的 HTML 与 CSS 子集，不执行脚本。
- 字体按使用的语言顺序回退；混排多语言时，汉字只使用列表中第一个 CJK 字体的字形。
- 首次出现新字符时需要先加载对应字体分片，该次渲染会稍慢。已加载的分片在服务运行期间常驻，内存随出现过的字符增多而增长，上限为全部字体。

协议：MIT。
