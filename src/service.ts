import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type Context, Service } from 'cordis'
import { Schema } from '@chatluna/schema'
import { h } from '@satorijs/core'
import { type ContainerNode, extractResourceUrls, type ImageNode, type ImageSource, type MeasuredNode, type Node, Renderer, type RenderOptions as TakumiOptions, type TextNode } from '@takumi-rs/core'
import { fromHtml } from '@takumi-rs/helpers/html'
import { type EmojiType, extractEmojis } from '@takumi-rs/helpers/emoji'

// Node types let callers build trees without depending on @takumi-rs/* themselves.
export type { ContainerNode, EmojiType, ImageNode, MeasuredNode, Node, TextNode }

export interface Config {
  concurrency: number
}

export const Config: Schema<Config> = Schema.object({
  concurrency: Schema.natural().min(1).max(16).default(2)
    .extra('label', '同时渲染数')
    .description('同时进行的渲染与测量任务上限，超出的任务排队等待。图片下载不占用名额。')
})

export interface RenderOptions extends Omit<TakumiOptions, 'fetchedResources'> {
  /** Downloads one remote image. The caller owns URL validation and size limits; failures render as a transparent placeholder. */
  fetch?: (url: string) => Promise<Uint8Array | ArrayBuffer>
  /** Replaces emoji with images from this set; those URLs also go through `fetch`. */
  emoji?: EmojiType
  signal?: AbortSignal
}

/** Picks which CJK font leads the fallback list, so shared Han characters use that language's glyph forms. */
export type FontLanguage = 'zh' | 'ja' | 'ko'

/** One font file of a fontsource package; `ranges` come from its unicode.json and are empty when the package lists none. */
interface Subset {
  name: string
  path: string
  ranges: [number, number][]
}

const placeholder = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')

/** fromHtml keeps entities; decoding the parsed tree, never raw HTML, keeps escaped text from becoming markup. */
export function decodeNode(node: Node): Node {
  if (node.type === 'text') return { ...node, text: h.unescape(node.text) }
  if (node.type === 'image') return { ...node, src: typeof node.src === 'string' ? h.unescape(node.src) : node.src }
  return { ...node, children: node.children?.map((child) => child ? decodeNode(child) : child) }
}

/** Parses HTML the same way `render` does: stylesheets are split out and entities decoded on the tree. */
export function parseHtml(html: string): { node: Node; stylesheets: string[] } {
  const stylesheets: string[] = []
  // fromHtml drops <style> inside <head>, so a full document would lose its CSS; lift every block out first.
  const body = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css: string) => {
    stylesheets.push(css)
    return ''
  })
  return { node: decodeNode(fromHtml(body).node), stylesheets }
}

function subsets(pkg: string, prefix: string): Subset[] {
  const root = dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`))
  const slug = pkg.slice(pkg.indexOf('/') + 1)
  const unicode: unknown = JSON.parse(readFileSync(resolve(root, 'unicode.json'), 'utf8'))
  if (typeof unicode !== 'object' || unicode === null) throw new Error(`Invalid unicode.json in ${pkg}`)
  // Keys are "[12]" for numbered CJK slices and "latin" style names otherwise; files drop the brackets.
  const rangesOf = new Map(Object.entries(unicode).flatMap(([key, range]) => typeof range === 'string'
    ? [[`${slug}-${key.replace(/^\[(\d+)\]$/, '$1')}-wght-normal.woff2`, range]]
    : []))
  return readdirSync(resolve(root, 'files')).filter((file) => file.endsWith('.woff2')).sort().map((file, i) => ({
    name: `Takumi${prefix}_${i}`,
    path: resolve(root, 'files', file),
    ranges: (rangesOf.get(file) ?? '').split(',').filter(Boolean).map((part): [number, number] => {
      const [start, end = start] = part.trim().slice(2).split('-')
      return [parseInt(start, 16), parseInt(end, 16)]
    })
  }))
}

function collectText(node: Node, points: Set<number>) {
  if (node.type === 'text') {
    for (const char of node.text) {
      const point = char.codePointAt(0)
      if (point !== undefined) points.add(point)
    }
  }
  if (node.type === 'container') node.children?.forEach((child) => child && collectText(child, points))
}

export default class Takumi extends Service {
  static override name = 'chatluna-takumi'
  static inject: string[] = []
  static Config = Config

  private engine?: {
    renderer: Renderer
    families: Record<FontLanguage, string>
    /** Subsets that can be loaded later, and which of them cover each code point seen so far. */
    lazy: Subset[]
    covering: Map<number, Subset[]>
    loaded: Set<string>
  }
  private fontLoading = Promise.resolve()
  private active = 0
  private waiting = new Set<() => void>()
  private lifetime = new AbortController()

  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, 'takumi')
    ctx.effect(() => () => this.lifetime.abort())
  }

  /** CSS font-family list led by Simplified Chinese; append a generic family after it. */
  get fontFamily(): string {
    return this.fontFamilyFor('zh')
  }

  /** CSS font-family list led by the given language's CJK font, then the other CJK fonts and DejaVu Sans. */
  fontFamilyFor(language: FontLanguage): string {
    return this.getEngine().families[language]
  }

  /** Renders an HTML string or a Takumi node tree. The service itself never touches the network. */
  async render(source: string | Node, options: RenderOptions = {}): Promise<Buffer> {
    const { node, settings, signal } = await this.prepare(source, options)
    return this.slot(signal, () => this.getEngine().renderer.render(node, settings, signal))
  }

  /** Lays out the source without drawing it; sizes and positions are in CSS pixels. */
  async measure(source: string | Node, options: RenderOptions = {}): Promise<MeasuredNode> {
    const { node, settings, signal } = await this.prepare(source, options)
    return this.slot(signal, () => this.getEngine().renderer.measure(node, settings, signal))
  }

  private async prepare(source: string | Node, options: RenderOptions) {
    const { fetch, emoji, signal: callerSignal, stylesheets = [], ...rest } = options
    const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal
    signal.throwIfAborted()
    const parsed = typeof source === 'string' ? parseHtml(source) : { node: source, stylesheets: [] }
    const node = emoji ? extractEmojis(parsed.node, emoji) : parsed.node
    const [fetchedResources] = await Promise.all([this.resources(node, fetch, signal), this.loadFonts(node)])
    signal.throwIfAborted()
    return { node, signal, settings: { ...rest, stylesheets: [...parsed.stylesheets, ...stylesheets], fetchedResources } }
  }

  private getEngine() {
    if (this.engine) return this.engine
    const sc = subsets('@fontsource-variable/noto-sans-sc', 'SC')
    const jp = subsets('@fontsource-variable/noto-sans-jp', 'JP')
    const kr = subsets('@fontsource-variable/noto-sans-kr', 'KR')
    const latin = subsets('@fontsource/dejavu-sans', 'Latin')
    const all = [...sc, ...jp, ...kr, ...latin]
    // Files without unicode ranges (all of DejaVu, about 2 MB) cannot be picked per character, so they load up front.
    const eager = all.filter((subset) => !subset.ranges.length)
    const family = (...groups: Subset[][]) => [...groups.flat(), ...latin].map((subset) => `'${subset.name}'`).join(',')
    return this.engine = {
      renderer: new Renderer({ fonts: eager.map((subset) => ({ name: subset.name, data: readFileSync(subset.path) })), loadDefaultFonts: true }),
      families: { zh: family(sc, jp, kr), ja: family(jp, sc, kr), ko: family(kr, sc, jp) },
      lazy: all.filter((subset) => subset.ranges.length),
      covering: new Map(),
      loaded: new Set(eager.map((subset) => subset.name))
    }
  }

  /**
   * Loads every subset whose unicode range covers a character in the tree. Takumi picks fallback fonts per text run
   * rather than per character, so loading only the first match in the font list can leave a run's chosen font
   * without its glyphs; with every covering subset present the output matches having all fonts loaded.
   */
  private async loadFonts(node: Node) {
    const engine = this.getEngine()
    const points = new Set<number>()
    collectText(node, points)
    const wanted = new Set<Subset>()
    for (const point of points) {
      let covering = engine.covering.get(point)
      if (!covering) {
        covering = engine.lazy.filter((subset) => subset.ranges.some(([start, end]) => point >= start && point <= end))
        engine.covering.set(point, covering)
      }
      for (const subset of covering) if (!engine.loaded.has(subset.name)) wanted.add(subset)
    }
    if (!wanted.size) return
    // Loads run one at a time so concurrent renders never read or add the same file twice.
    const task = this.fontLoading.then(async () => {
      const missing = [...wanted].filter((subset) => !engine.loaded.has(subset.name))
      if (!missing.length) return
      const fonts = await Promise.all(missing.map(async (subset) => ({ name: subset.name, data: await readFile(subset.path) })))
      await engine.renderer.loadFonts(fonts, this.lifetime.signal)
      for (const subset of missing) engine.loaded.add(subset.name)
      this.ctx.logger.debug('Loaded %d font subsets, %d in total', missing.length, engine.loaded.size)
    })
    this.fontLoading = task.catch(() => {})
    await task
  }

  private async resources(node: Node, fetch: RenderOptions['fetch'], signal: AbortSignal): Promise<ImageSource[]> {
    const urls = [...new Set(extractResourceUrls(node))].filter((src) => !src.startsWith('data:'))
    const resources: ImageSource[] = []
    for (let i = 0; i < urls.length; i += 4) {
      resources.push(...await Promise.all(urls.slice(i, i + 4).map(async (src) => {
        if (!fetch) return { src, data: placeholder }
        try {
          return { src, data: await fetch(src) }
        } catch {
          signal.throwIfAborted()
          this.ctx.logger.debug('Image resource unavailable')
          return { src, data: placeholder }
        }
      })))
      signal.throwIfAborted()
    }
    return resources
  }

  private async slot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    while (this.active >= this.config.concurrency) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const abort = () => resolve()
      this.waiting.add(resolve)
      signal.addEventListener('abort', abort, { once: true })
      await promise
      this.waiting.delete(resolve)
      signal.removeEventListener('abort', abort)
      signal.throwIfAborted()
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      // Every waiter re-checks the limit, so an aborted waiter cannot strand the free slot.
      for (const wake of this.waiting) wake()
    }
  }
}

declare module 'cordis' {
  interface Context {
    takumi: Takumi
  }
}
