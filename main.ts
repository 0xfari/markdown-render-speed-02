// Driver for markdown-render-speed-02: reads the case set, renders every
// case with parse() from parse.js, writes the HTML array out.
// Runs as `node /bot/main.ts` (Node 22, erasable TS only). Outside a
// container the input/output dirs come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR; inside, they default to /input and /output.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inputPath = join(inputDir, 'cases.json');
if (!existsSync(inputPath)) {
  throw new Error(`cases.json not found at ${inputPath} (set MAKEFUN_INPUT_DIR)`);
}
const cases = JSON.parse(readFileSync(inputPath, 'utf8')) as Array<{ id: string; markdown: string }>;
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
// the scorer may hand us a fresh output dir that does not exist yet
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
