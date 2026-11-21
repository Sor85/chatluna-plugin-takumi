# Agent Note: Takumi rendering service

Status: implemented

## Problem

Several ChatLuna plugins (bilibili-videolink-card, impart, mc-toolbox, meme-generator) each embedded a Takumi Renderer and the same fonts. With all of them enabled, fonts and native renderers stayed resident several times, renders competed for CPU, and dependency versions drifted apart.

## Decision

- Provide `ctx.takumi` as a Cordis 4 Service (`src/service.ts`) holding one Renderer and one font set (Noto Sans SC, JP, KR and DejaVu Sans), loaded on demand (below). `fontFamilyFor(language)` puts that language's CJK font first so shared Han characters use its glyph forms; `fontFamily` equals `zh`.
- The interface is `render(source, options)` and `measure(source, options)`: `source` is an HTML string or a node tree, returning an image Buffer or a layout. The `Renderer` is not exposed and node types are re-exported, so callers do not depend on `@takumi-rs/*`.
- HTML input goes through `parseHtml`: every `<style>` block is lifted out first (`fromHtml` drops styles inside `<head>`, so a full document would lose its CSS), then entities are decoded on the node tree (`decodeNode`). Callers escape untrusted text first.
- The service makes no network requests: remote images and emoji go through the caller's `fetch`, and failures or a missing `fetch` render a transparent placeholder. Trusted hosts and size limits stay with each caller.
- Fonts load on demand: building the Renderer only indexes subsets from fontsource `unicode.json` files and loads DejaVu, which lists no ranges; before each render or measure every subset covering a character in the text is loaded, one load at a time. Measured font memory is about 34 MB for typical text against 59 MB with everything loaded; the first render that meets new characters takes roughly 30–50 ms longer.
- `concurrency` (default 2, range 1–16) limits only `Renderer.render` and `measure`; releasing a slot wakes every waiter to re-check. Renders honour both the caller's `signal` and service disposal.

## Alternatives considered

- A shared npm library: removes duplicate code but saves no memory.
- Downloading images inside the service: it cannot know each caller's trusted hosts and limits; rejected.
- Exposing animation and other Takumi APIs: no caller needs them yet. `measure` exists because meme-generator paginates its list with it.
- Required versus optional: plugins whose main output is an image (the Bilibili card) require the service; plugins that can fall back to text (impart, mc-toolbox, meme-generator) declare it optional and read it with `ctx.get`, so disabling this plugin does not stop them entirely.
- Loading only the first subset covering each character in the fallback list: Takumi picks fonts per text run, so "한국어" chose the Korean font while "국" had only its Simplified Chinese subset loaded and drew a missing glyph; the output differed from loading everything, so this was rejected.

## Consequences

- Plugins depending on this service require users to install this plugin too.
- Upgrading Takumi or fonts touches only this plugin; adding fonts affects memory for every caller.
- Loaded subsets stay resident while the service runs, so memory grows slowly with the characters seen, up to the full font set.
