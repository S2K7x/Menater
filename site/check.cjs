/**
 * Checks the built site the way the console's own theme test checks the
 * console: by MEASURING, not by looking at it.
 *
 *     cd site && ./build.sh
 *     python3 -m http.server 8899 &
 *     node check.cjs                    # needs playwright on NODE_PATH
 *
 * Three things, over both pages, both languages and all six palettes:
 *
 *   - contrast >= 4.5:1 on every piece of text that names something. The
 *     first run of this file found six: the label under a hero number, a
 *     table header, the conditions line under a figure, the sidebar group,
 *     the front page's most important sentence, and the accent used as TEXT
 *     on the darkest inset (2.58:1 in punk).
 *   - no horizontal overflow, from 320 px up. A page that scrolls sideways
 *     on a phone hides its own right-hand edge.
 *   - every in-page anchor resolves, and no script throws. The shared script
 *     runs on two pages that do not have the same elements.
 *
 * Exits non-zero on a contrast failure, so it can gate a change.
 */
const { chromium } = require('playwright');
function lum(c){const m=c.match(/[\d.]+/g).map(Number);const [r,g,b]=m.slice(0,3).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*r+0.7152*g+0.0722*b}
function ratio(a,b){const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)}
const PROBES = [
  ['.langs [aria-current] .l-long', '.langs [aria-current]', 'lang chip'],
  ['.ghlink', 'body', 'header link'],
  ['.btn', '.btn', 'primary button'],
  ['.claims .c-t', 'body', 'claim title'],
  ['.claims .c-d', 'body', 'claim body'],
  ['.fn-you', '.fn-you', 'gate badge'],
  ['.fn-d', '.flow-node', 'step body'],
  ['.flow-outcomes .ok-green', '.flow-outcomes li', 'outcome yes'],
  ['.flow-outcomes .ok-grey', '.flow-outcomes li', 'outcome no'],
  ['.flow-outcomes .ok-orange', '.flow-outcomes li', 'outcome silence'],
  ['.card p', '.card', 'card body'],
  ['.spec .k', '.spec', 'spec label'],
  ['.shot figcaption', 'body', 'caption'],
  ['.docs-toc nav a[aria-current]', '.docs-toc nav a[aria-current]', 'sidebar active'],
  ['.docs-toc nav a', 'body', 'sidebar link'],
  ['.docs-toc .grp', 'body', 'sidebar group'],
  ['.callout', '.callout', 'callout'],
  ['.note', '.note', 'note'],
  ['.gloss dd', 'body', 'glossary body'],
  ['.gloss dt', 'body', 'glossary term'],
  ['.docs-body > section > p', 'body', 'docs prose'],
  ['.rows .d', 'body', 'rows body'],
  ['td', '.tablewrap', 'table cell'],
  ['th', 'th', 'table header'],
  ['.fig .c', '.fig', 'figure caption'],
  ['.kick', 'body', 'eyebrow'],
  ['.lock .tagline', 'body', 'tagline'],
  ['.flow-note', 'body', 'flow note'],
  ['.fn-n', '.flow-node', 'step number'],
  ['.foot p', '.foot', 'footer note'],
  ['pre .c', 'pre', 'code comment'],
  ['pre .a', 'pre', 'code accent'],
  ['.docs-toc nav a[aria-current] .n', '.docs-toc nav a[aria-current]', 'sidebar number (on)'],
  ['.docs-toc nav a:not([aria-current]) .n', 'body', 'sidebar number'],
  ['.docs-head .lede', 'body', 'docs lede'],
  ['.lede', 'body', 'lede'],
  ['.hero-sub', 'body', 'hero subtitle'],
  ['h1', 'body', 'h1'],
  ['.docs-body h2', 'body', 'docs h2'],
];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:1400,height:1000}});
  await p.route('**://fonts.*/**', r=>r.abort());
  let bad = [], seen = 0;
  for (const url of ['http://localhost:8899/', 'http://localhost:8899/docs/',
                     'http://localhost:8899/fr/', 'http://localhost:8899/fr/docs/']) {
    for (const t of ['grayed','punk','blued','attck','acme','dark']) {
      await p.goto(url, {waitUntil:'domcontentloaded'});
      await p.evaluate(x=>localStorage.setItem('menater.site.theme',x), t);
      await p.reload({waitUntil:'domcontentloaded'});
      await p.evaluate(()=>window.scrollTo(0, 900));   // wake the scroll-spy
      await p.waitForTimeout(120);
      const res = await p.evaluate(P => P.map(([fg,bg,name]) => {
        const f = document.querySelector(fg), g = document.querySelector(bg);
        if (!f || !g) return null;
        let c = getComputedStyle(g).backgroundColor, el = g;
        while ((c === 'rgba(0, 0, 0, 0)' || c === 'transparent') && el.parentElement) {
          el = el.parentElement; c = getComputedStyle(el).backgroundColor;
        }
        return [name, getComputedStyle(f).color, c];
      }).filter(Boolean), PROBES);
      for (const [name, fg, bg] of res) {
        seen++;
        const v = ratio(fg, bg);
        if (v < 4.5) bad.push(`${url.replace('http://localhost:8899','')} ${t} ${name} ${v.toFixed(2)}:1`);
      }
    }
  }
  console.log(`${seen} contrast checks`);
  if (bad.length) { console.log('FAILING:'); bad.forEach(x=>console.log('  '+x)); }
  else console.log('all >= 4.5:1');

  // Overflow + structure, at a phone width.
  for (const url of ['http://localhost:8899/', 'http://localhost:8899/docs/']) {
    for (const w of [320, 390, 768, 1400]) {
      const q = await b.newPage({viewport:{width:w,height:800}});
      await q.route('**://fonts.*/**', r=>r.abort());
      const errs=[]; q.on('pageerror', e=>errs.push(e.message));
      await q.goto(url, {waitUntil:'domcontentloaded'});
      await q.waitForTimeout(250);
      const o = await q.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const dead = await q.evaluate(()=>[...document.querySelectorAll('a[href^="#"]')]
          .filter(a=>a.getAttribute('href').length>1 && !document.querySelector(a.getAttribute('href')))
          .map(a=>a.getAttribute('href')));
      console.log(`${url.replace('http://localhost:8899','')} @${w}  overflow ${o}px  dead-anchors ${dead.length?dead:0}  js ${errs.length?errs:'ok'}`);
      await q.close();
    }
  }
  await b.close();
  process.exit(bad.length ? 1 : 0);
})();
