# Vendored libraries for the Read view

Downloaded with `npm pack` and unpacked; only the files below are kept. All are served by Caddy from this directory
(`term.js` loads them on demand), so nothing is fetched from a CDN.

| Library | Version | Files | Licence |
| --- | --- | --- | --- |
| marked | 15.0.12 | `marked.min.js` | MIT |
| DOMPurify | 3.4.16 | `purify.min.js` (from `dist/`) | Apache-2.0 / MPL-2.0 |
| KaTeX | 0.16.47 | `katex.min.js`, `katex.min.css`, `fonts/*.woff2` | MIT |
| highlight.js (`@highlightjs/cdn-assets`) | 11.12.0 | `highlight.min.js` (common languages), `matlab.min.js` | BSD-3-Clause |
| @xterm/addon-canvas | 0.7.0 | `xterm-addon-canvas.js` (`lib/addon-canvas.js`, renamed; licence in `LICENSE-xterm-addon-canvas.txt`) | MIT |

* `katex.min.css`: every `@font-face` `src` was reduced to its `woff2` entry, so browsers never request the `woff`/`ttf`
  files that are not shipped.
* `matlab.min.js` registers itself on `window.hljs`, so it must load after `highlight.min.js` (see `loadLibs` in `term.js`).

`xterm-addon-canvas.js` is not used by the Read view: `term.js` loads it into the terminal's own document on desktops (see `loadCanvasRenderer`). It must pair with the xterm.js core inside ttyd (5.4/5.5 for ttyd 1.7.7: `@xterm/addon-canvas@0.5` throws on it, `0.7.0` works); re-test after a ttyd upgrade.

To update: `npm pack marked@15 dompurify@3 katex@0.16 @highlightjs/cdn-assets@11` in an empty directory, unpack, copy the
same files, redo the KaTeX CSS rewrite, bump the versions here, and re-run the browser QA.
