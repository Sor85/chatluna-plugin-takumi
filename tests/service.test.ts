import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Renderer } from '@takumi-rs/core'
import Takumi, { Config, decodeNode, type FontLanguage, type Node, parseHtml } from '../src'

const hosts: Context[] = []
afterEach(async () => {
  for (const ctx of hosts.splice(0)) await ctx.fiber.dispose()
})

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  hosts.push(ctx)
  await ctx.plugin(Takumi, Config.parse(config))
  return ctx
}

const html = (fontFamily: string) => `<style>.box { width: 320px; padding: 16px; font-family: ${fontFamily}, sans-serif; font-size: 16px; line-height: 1.5; }</style>
<div class="box"><p>中文 &lt;b&gt; 한국어 🎉</p><img src="https://example.com/a.png?x=1&amp;y=2" style="width: 32px; height: 32px" /></div>`

/** Every font file under the service's naming, to check that on-demand loading draws the same pixels. */
function fullRenderer() {
  const require = createRequire(import.meta.url)
  const fonts = [['@fontsource-variable/noto-sans-sc', 'SC'], ['@fontsource-variable/noto-sans-jp', 'JP'], ['@fontsource-variable/noto-sans-kr', 'KR'], ['@fontsource/dejavu-sans', 'Latin']].flatMap(([pkg, prefix]) => {
    const directory = resolve(dirname(require.resolve(`${pkg}/package.json`)), 'files')
    return readdirSync(directory).filter((name) => name.endsWith('.woff2')).sort().map((name, i) => ({ name: `Takumi${prefix}_${i}`, data: readFileSync(resolve(directory, name)) }))
  })
  return new Renderer({ fonts, loadDefaultFonts: true })
}

const mixed = '骨直写角刃 今日は天気 ひらがな カタカナ 안녕하세요 한국어 The quick brown fox 0123 ©→★ 繁體字 Tiếng Việt'

function size(png: Buffer) {
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('Takumi 服务', () => {
  it('配置并发有界', () => {
    expect(Config.parse({}).concurrency).toBe(2)
    for (const concurrency of [0, 17]) expect(() => Config.parse({ concurrency })).toThrow()
  })

  it('解析后解码实体，文本不会变成 HTML 标签', () => {
    expect(decodeNode({ type: 'text', text: '&lt;script&gt; &amp; &amp;lt; &#39;' })).toEqual({ type: 'text', text: "<script> & &lt; '" })
    expect(decodeNode({ type: 'image', src: 'https://i0.hdslb.com/a?x=1&amp;y=2' })).toEqual({ type: 'image', src: 'https://i0.hdslb.com/a?x=1&y=2' })
  })

  it('渲染中韩文字 PNG，远程图片与 emoji 只经调用方下载', async () => {
    const ctx = await setup()
    const requested: string[] = []
    const png = await ctx.takumi.render(html(ctx.takumi.fontFamily), {
      width: 352, format: 'png', emoji: 'twemoji',
      fetch: async (url) => {
        requested.push(url)
        throw new Error('Fixture resource unavailable')
      }
    })
    expect(size(png).width).toBe(352)
    expect(requested).toContain('https://example.com/a.png?x=1&y=2')
    expect(requested.some((url) => url.includes('/twemoji@') && url.endsWith('/1f389.svg'))).toBe(true)
  })

  it('按语言调整中日韩字体顺序，日文假名可渲染', async () => {
    const ctx = await setup()
    expect(ctx.takumi.fontFamily).toBe(ctx.takumi.fontFamilyFor('zh'))
    for (const [language, first] of [['zh', 'SC'], ['ja', 'JP'], ['ko', 'KR']] as const) {
      const fonts = ctx.takumi.fontFamilyFor(language).split(',')
      expect(fonts[0]).toBe(`'Takumi${first}_0'`)
      expect(fonts.at(-1)).toMatch(/^'TakumiLatin_\d+'$/)
    }
    const html = `<div style="width: 400px; font-family: ${ctx.takumi.fontFamilyFor('ja')}, sans-serif; font-size: 24px">ひらがな カタカナ 日本語の文章</div>`
    expect(size(await ctx.takumi.render(html, { format: 'png' })).width).toBe(400)
  })

  it('按需加载字体与全量加载逐像素一致，覆盖样式表、内联样式与节点树', async () => {
    const ctx = await setup()
    const full = fullRenderer()
    for (const language of ['zh', 'ja', 'ko'] satisfies FontLanguage[]) {
      const family = ctx.takumi.fontFamilyFor(language)
      const inline = `<div style="width: 640px; padding: 12px; background: #fff; font-family: ${family}, sans-serif; font-size: 28px">${mixed}</div>`
      const sheet = `<style>.t { width: 640px; padding: 12px; background: #fff; font-family: ${family}, sans-serif; font-size: 28px; }</style><div class="t">${mixed}</div>`
      const node: Node = { type: 'container', style: { width: 640, padding: 12, backgroundColor: '#fff', fontFamily: family, fontSize: 28 }, children: [{ type: 'text', text: mixed }] }
      for (const source of [inline, sheet]) {
        const parsed = parseHtml(source)
        const expected = await full.render(parsed.node, { format: 'png', stylesheets: parsed.stylesheets })
        expect((await ctx.takumi.render(source, { format: 'png' })).equals(expected)).toBe(true)
      }
      expect((await ctx.takumi.render(node, { format: 'png' })).equals(await full.render(node, { format: 'png' }))).toBe(true)
    }
  })

  it('并发渲染不同文字时字体加载排队，结果与单独渲染一致', async () => {
    const ctx = await setup({ concurrency: 4 })
    const texts = ['春眠不觉晓', 'ひらがなカタカナ', '안녕하세요', '処暑の候', '骨直写角刃', 'Ünïcödé ©→★']
    const html = (text: string) => `<div style="width: 300px; font-family: ${ctx.takumi.fontFamilyFor(text.includes('処') ? 'ja' : 'zh')}; font-size: 24px">${text}</div>`
    const together = await Promise.all(texts.map((text) => ctx.takumi.render(html(text), { format: 'png' })))
    const alone = await setup()
    for (const [i, text] of texts.entries()) expect(together[i]!.equals(await alone.takumi.render(html(text), { format: 'png' }))).toBe(true)
  })

  it('measure 与 render 使用同样的解析，返回 CSS 像素布局', async () => {
    const ctx = await setup()
    const layout = await ctx.takumi.measure('<style>.row { height: 40px; }</style><div style="width: 300px"><div class="row">a</div><div class="row">b</div></div>', { width: 300 })
    expect(layout.width).toBe(300)
    expect(layout.height).toBe(80)
    const parsed = parseHtml('<style>.a { color: red; }</style><p>&lt;b&gt;</p>')
    expect(parsed.stylesheets.join('')).toContain('.a')
    expect(JSON.stringify(parsed.node)).toContain('<b>')
    const page = await ctx.takumi.measure('<!doctype html><html><head><style>body { margin: 0; } .row { height: 30px; }</style></head><body><div class="row">a</div></body></html>', { width: 200 })
    expect(page.height).toBe(30)
  })

  it('未提供下载函数时用占位图，接受节点树输入', async () => {
    const ctx = await setup()
    expect(size(await ctx.takumi.render(html(ctx.takumi.fontFamily), { format: 'png' })).height).toBeGreaterThan(0)
    const node = { type: 'container' as const, style: { width: 64, height: 32, backgroundColor: '#f1f2f3' }, children: [] }
    expect(size(await ctx.takumi.render(node, { format: 'png' }))).toEqual({ width: 64, height: 32 })
  })

  it('并发为 1 时排队渲染全部完成', async () => {
    const ctx = await setup({ concurrency: 1 })
    const results = await Promise.all([1, 2, 3].map((n) => ctx.takumi.render(`<div style="width: ${n * 10}px; height: 10px"></div>`, { format: 'png' })))
    expect(results.map((png) => size(png).width)).toEqual([10, 20, 30])
  })

  it('调用方取消或服务卸载后拒绝渲染', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.takumi.render('<div></div>', { signal: controller.signal })).rejects.toThrow()
    const takumi = ctx.takumi
    await ctx.fiber.dispose()
    await expect(takumi.render('<div></div>')).rejects.toThrow()
  })
})
