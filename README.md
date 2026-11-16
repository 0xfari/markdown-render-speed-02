# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/0xfari/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/0xfari/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written Markdown renderer that produces byte-identical output to marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29, default options) — and runs about 1.9x faster than marked on the practice set. `parse.js` is a single self-contained ES module: a block parser (ATX/setext/fenced/indented code, HTML blocks, quotes, lists, tables, task lists, reference definitions) over a flat doubly-linked inline node list (emphasis, links, autolinks, code spans, entities, strikethrough). No dependencies, no network, no caching across cases.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` reads `cases.json` from the input dir, renders every case with `parse()`, and writes `html.json` to the output dir. Inside the scoring container it reads `/input/cases.json` and writes `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p5tm223q&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
