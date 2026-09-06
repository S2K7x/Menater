# MENATER — Brand and design reference

**This file is the single source of truth for how MENATER looks and sounds.**
It exists so the same decision is never taken twice, and never taken by
accident. If a colour, a size or a word is not in here, it is not part of the
brand yet — add it here first, then use it.

Companion files, which this document governs:

| File | Holds |
|---|---|
| `dashboard/src/theme/themes.css` | The six palettes. One block per theme, the entire palette each time |
| `dashboard/src/theme/themes.test.ts` | The WCAG contrast test that refuses a palette |
| `dashboard/src/styles.css` | Geometry and typography — everything that does not change between themes |
| `dashboard/src/vulnpipe/*.css` | The Code section, scoped under `.vp-embed` |

---

## 1. The name

**MENATER** comes from the Hebrew **מנטר** (*menater*) — the present tense of
*lenater*, to monitor. The product is not named after a technology. It is named
after **an action in progress**.

Everything else follows from that:

- it is a **verb**, so the brand speaks in the present and in the active voice;
- it is **continuous**, so the console shows a state, never a finished report;
- it is **an act of watching**, not of deciding — which is exactly the product's
  security model: it watches, a human acts.

**Writing the name.** `MENATER` in full capitals when it is the product;
*Menater* in sentence case only inside running prose where full caps would
shout. Never *MenaTer*, never *Menater.io*, never a lowercase `menater` outside
of code identifiers (`menater.theme`, `menater://queue`, the npm scope).

The Hebrew form **מנטר** may appear once, small, as an origin note — on the
About screen, the brand page, the repository README. It is a signature, not a
logo, and it is never the primary lockup: it would be unreadable to most of the
audience and Hebrew is right-to-left, which breaks every horizontal lockup it
is dropped into.

---

## 2. The brand idea

> **MENATER watches in the present, and says what it cannot see.**

The whole product already argues this, in code, in five places:

| The product rule | Where it lives |
|---|---|
| Never fill a gap with a default. Missing data is shown as missing | The two-tier alert contract |
| Silence is never consent — an approval timeout executes nothing | The approval flow |
| No irreversible action without an explicit human act | The closed action catalogue |
| A failure must never show green | The Tracking tab exists only for this |
| The assistant cannot act, only read | Seven getters, no writes |

**So the brand promise is not "we automate your SOC". It is: nothing here is
invented, and the console will tell you what it does not know.**

That is the differentiator. Every competitor sells automated confidence. MENATER
sells **legible restraint** — and the design has to carry that, or the design is
lying about the product.

### What the design must therefore do

1. **Show absence.** A missing value is a first-class visual state, designed on
   purpose, never an empty cell and never a zero.
2. **Never reassure by default.** Green is earned, not assumed.
3. **Look measured, not marketed.** The register is a laboratory instrument, not
   a landing page.
4. **Reward a second look.** Density is welcome; decoration is not.

---

## 3. Direction: *Instrument*

The chosen register, of three considered.

**Cold charcoal, one acid-green accent, heavy condensed capitals, monospaced
data, hairline rules, 4 px radius.** It reads as a measuring instrument: a thing
built to be *read*, by someone whose attention is already spent elsewhere.

Why this and not the alternatives — kept because a rejected option is part of
the decision:

- **Registry** (cream paper, printer's red, the audit hash chain as a motif) is
  more distinctive — nobody in security brands as paper — but it reads as
  *compliance*, and MENATER's primary screen is an operations queue.
- **Signal & Silence** (near-monochrome; colour only where a human is blocked)
  is the most rigorous and the hardest to imitate, but it does not carry a
  first impression. It survives inside this direction as **rule 4 of §5**.

---

## 4. Voice

Written English, everywhere: code, comments, UI strings, documentation. The
product was bilingual; it is not any more. The i18n catalogue machinery is kept
because it is what keeps user-facing strings out of components — not because a
second locale is coming.

### The five voice rules

1. **Name the thing, then the consequence.** *"No model key. Every alert takes
   the fail-safe verdict: nothing is lost, nothing is triaged."* Not *"Setup
   incomplete."*
2. **Never say a thing is fine when nobody looked.** *Not asked* is a different
   sentence from *nothing found*, and the difference is the whole product.
3. **Say what happens next, and who does it.** The console never acts on its
   own, so every message ends in someone's hands.
4. **No exclamation marks, no emoji in product surfaces, no "Oops".** A triage
   console interrupts people at 3 a.m.; cheerfulness reads as not understanding
   the situation.
5. **Prefer the short true sentence to the short reassuring one.** *"The
   database is unreachable (ECONNREFUSED)."* beats *"Something went wrong."*

### Register

| Do | Don't |
|---|---|
| It refuses to run: no host to isolate | Action failed |
| Nothing new for 5 minutes, outside an approval wait | Stalled ⚠️ |
| 3 of 5 sources answered | Clean |
| This log appears to contain an injection attempt | Suspicious content detected! |
| Shadow mode: decisions are recorded, none are executed | Safe mode enabled |

### Terminology is fixed

A pipeline identifier is never shown raw. `shadow_logged`, `needs_human`,
`isolate_host_temporary` go through the catalogue. A value outside the catalogue
is rendered **as-is** rather than invented — the same rule as missing data.

---

## 5. Colour

### The five rules, in priority order

1. **One accent per screen.** The acid green designates exactly one thing at a
   time. Two accents means neither is one.
2. **Red and orange are not decorative.** Red says *critical or failed*, orange
   *worth a look*, green *handled*. A red button would teach an analyst to
   ignore red on the one screen where red saves time. This is the rule the
   product rests on: colour is processed pre-attentively, before reading, so it
   is the fastest channel the interface has — and the easiest to spend on
   nothing.
3. **The palette is a variable; the roles are fixed.** No rule outside
   `themes.css` knows a theme's name. A hardcoded colour is immediately wrong:
   it will follow none of the six themes.
4. **Only "waiting for a human" carries the accent.** It is the one state where
   the system is blocked and someone must act. Verdicts, severities and sources
   use the risk palette.
5. **Colour never carries meaning alone.** WCAG 1.4.1. Every risk colour is
   paired with a word, and usually a shape (pill, inset bar, icon).

### Token roles

The palette is one CSS block per theme. Every theme redefines **all** of it —
inheriting three tokens produces an accident invisible on review.

| Token | Role |
|---|---|
| `--bg` | The page ground |
| `--surface` / `--surface-2` | Panels, and panels on panels |
| `--panel` | A panel set *back* from the ground |
| `--hero` | An **inset** — one step further from the text, in the same direction as the theme. Dark on a dark theme, **light on a light theme**. Never the inverse: set near-black on the light theme it equalled `--fg` exactly, giving 1.00:1 in eight places |
| `--fg` | Body text |
| `--muted` | Secondary mentions (≥ 3:1) |
| `--faint` | Tertiary, labels, kickers (≥ 3:1) |
| `--line` / `--line-strong` | Hairlines, and hairlines that must be seen |
| `--accent` | The one accent. **Waiting for a human**, primary action, links |
| `--accent-dim` | Its hover/pressed state |
| `--accent-fg` | Text laid **on** the accent. Follows the accent's contrast, not the background's — a bright accent wants dark text |
| `--red` `--orange` `--green` `--blue` `--grey` | The risk palette |
| `--*-bg` | The same, as a pill ground |
| `--shadow` | Elevation. Discreet on light themes: a dark theme's shadow reads as dirt on cream |

### The six themes

`data-theme` on `<html>`, set by a script in `index.html` **before the first
paint**. That script deliberately duplicates the storage key and the theme list
— it runs before any module, so it can import nothing; a test checks the two
have not drifted.

| Theme | Palette | Note |
|---|---|---|
| `grayed` | Slate, acid green | The default, and the brand's own palette |
| `punk` | Military khaki, corporate red, cream type | Red is the **accent** here, so `--red` shifts to a light vermilion or an error would look like an ordinary button |
| `blued` | Electric blue, lime | The ground *is* a saturated colour: surfaces rise in lightness instead of falling |
| `attck` | Incandescent orange, signal yellow | Depth inverts — panels are darker than the ground |
| `acme` | **Light.** Cream paper, printer's red, black ink | No role inverts. `--hero` stays an inset, so a darker paper — never ink |
| `dark` | Near-black grey, application blue | The most neutral of the six |

**Brand palette = `grayed`.** Marketing surfaces, the favicon, the social card
and screenshots use it. The other five are the user's choice, not the brand's.

### Contrast is tooled, never judged by eye

`themes.test.ts` computes the WCAG ratios and **refuses** a palette:

| Pair | Minimum |
|---|---|
| `--fg` on `--bg`, on `--surface`, on `--hero` | 4.5:1 |
| `--accent-fg` on `--accent` | 4.5:1 |
| Risk palette on panels, and inside its own `--*-bg` pills | 4.5:1 |
| `--muted`, `--faint` | 3:1 |
| Every token present in every theme | required |

This test is not ceremony. It caught Attck's failure red at **2.5:1** — on the
screen that depends on red most — and an original defect in the historic theme,
`--faint` at 2.77:1 on panels. **A palette lifted straight from a poster gives
ravishing, unreadable pastels: a reference image is lit and composed; its
colours laid down as interface surfaces carry nothing. Lower the values, keep
the hue.**

---

## 6. Typography

Three faces, three jobs, no fourth.

| Token | Face | Job |
|---|---|---|
| `--display` | **Archivo Black**, fallback Helvetica Neue / Arial Narrow / Impact | Headings and kickers. Uppercase, tight tracking. Carries the whole register |
| `--sans` | **Inter** 400/500/700, fallback system-ui | Body, labels, prose |
| `--mono` | `ui-monospace`, SF Mono, Menlo | **Every value produced by the system**: identifiers, IPs, hashes, verdicts, timestamps, counts, code |

**The monospace rule is semantic, not decorative.** Mono means *this string came
from the machine, and it is exact*. Prose about a value is sans; the value is
mono. That distinction is the reason a fourth typeface would cost something:
NN/g classes "different font styles that don't convey any unique meaning" as
extraneous cognitive load — a tax levied on an analyst scanning forty rows.

Fonts load from Google Fonts with `preconnect`, and **fall back to system faces
when the network is absent**. A console on an isolated network must not lose its
hierarchy because a CDN is unreachable — which is why the fallback stack for
`--display` is condensed and heavy, not a default sans.

### The scale

Sizes in `rem`, so a user's browser setting is respected.

| Step | Size | Use |
|---|---|---|
| `h1` | `clamp(1.8rem, 4vw, 2.8rem)` | Login screen only |
| page title | `clamp(1.5rem, 3vw, 2.1rem)` | `.soc-panel.soc-page-head h2` — **one per screen** |
| `h2` | `1rem`, tracking `+0.06em` | A section inside a page |
| display | `1.7rem` | Big numbers, metric figures |
| logo | `1.45rem` | The wordmark in the header |
| `h3` | `0.86rem`, tracking `+0.06em` | A block inside a section |
| body | `0.94rem` (15 px) | Prose |
| dense | `0.86rem` | Dense body, table cells |
| secondary | `0.78rem` | Secondary line, sub-labels |
| data | `0.72rem` | Mono data in tables |
| micro | `0.66rem` | Pills, kickers, uppercase micro-labels |

**Eight `rem` steps plus the two clamps. That is the whole scale**, and the
stylesheets now hold exactly those and nothing else.

**Three heading levels, and nothing between them.** A page title, a section, a
block inside a section — the sizes above are that scale and not a suggestion.
The page title wins by SPECIFICITY (`.soc-panel.soc-page-head h2` is (0,2,1)
against `.soc-panel h2` at (0,1,1)), never by document order, which the next
edit to the stylesheet would silently change. `.vp-embed` carries the same three
levels so the two halves of the application do not read as two applications.

*Why the section heading is a label and not a headline:* every panel used to
open with one sized like the page title, so a tab whose whole content was
"nothing to report" carried three billboards. When everything shouts, nothing is
loud. See [CLARITY.md](CLARITY.md) § 2.

**Two documented exceptions, both in `px` on purpose:**

| Exception | Why |
|---|---|
| `font-size: 16px` on form inputs | Below 16 px, iOS zooms the page on focus and the user is left scrolling a layout they no longer recognise |
| `8.5px` / `9px` / `10px` / `11px` / `13px` on `.soc-wf-*` and `.vp-dgm-*` | SVG labels, sized in user units on a fixed drawing canvas. They are not page text and do not belong to the page scale |

**Line length.** Prose is capped around 70–80 characters. `.soc-app` is
`max-width: 1440px`, which is a *table* width, not a *reading* width: a
paragraph inside it needs its own cap.

---

## 7. Space, geometry, elevation

**Spacing scale — 2 px base:** `2 · 4 · 6 · 8 · 10 · 12 · 16` for anything
inside a component, then `24 · 32 · 40 · 48 · 64 · 80` for layout. Nothing else.

The scale is 2 px-based rather than the more fashionable 4 px because it was
**derived from the code, not imposed on it** — `6` and `10` were already the
two most common values in the sheet, and forcing fifty two-pixel shifts across
screens nobody would re-review is a cost with no reader on the other end. What
the scale removes is the genuinely rogue values: `1 · 3 · 5 · 9 · 14 · 18 · 22`.

**Radius: `--radius: 4px`, `50%` for a dot.** Nothing between. Large radii are
the single loudest "consumer app" signal there is, and this product is not one.

**One documented exception:** the switch track (`.vp-switch-track`) keeps a full
capsule. That shape *is* the signifier for a switch — a square one reads as a
checkbox, which does something else. An asymmetric corner is allowed where it
carries meaning: the assistant's message bubbles drop one corner
(`var(--radius) var(--radius) var(--radius) 0`) to point at the speaker.

**Borders before shadows.** A 1 px `--line` hairline separates; `--shadow` is
reserved for what actually floats above the page — the assistant panel, a
dialog, the sticky save bar. Panels do not float.

**Density is a feature.** The triage table is meant to show forty rows. Do not
"give it room to breathe" — an analyst scrolling is an analyst who has lost the
overview.

---

## 8. Components — the fixed contracts

| Element | Rule |
|---|---|
| **Kicker** (`.soc-kicker`) | Mono, `0.68rem`, tracking `0.22em`, uppercase, `--faint`. The device that says "this is an instrument" |
| **Pill** | `--<risk>` text on `--<risk>-bg` ground, mono, uppercase, `0.66rem`. Always carries a word |
| **Panel** (`.soc-panel`) | `--surface` on `--bg`, 1 px `--line`, `--radius` |
| **Inset** | `--hero`, for anything quoted verbatim from the machine: raw logs, connection strings, code |
| **Primary button** | `--accent` ground, `--accent-fg` label. **One per screen.** A destructive action is *not* red-buttoned — it is a plain button with a confirmation |
| **Missing value** | The em dash `—` in `--faint`, with the reason available. **Never** `0`, never `N/A`, never an empty cell, never a guess |
| **Confidence bar** | Length + colour. Length is the pre-attentive channel; colour is the confirmation |
| **Freshness** | A "new" badge under 10 minutes — because `closed` is the weakest sort weight, and in shadow mode every handled alert ends `closed` |

### Class naming

Prefix per surface, and **check a prefix is free before writing it**:

`soc-` console · `vp-` VulnPipe (scoped under `.vp-embed`) · `soc-ai-` assistant
· `soc-intel-` Lookup.

Two live traps:

- `.vp-scope` and `.soc-sources` were **already taken**. The merged container is
  `.vp-embed`; the log-sources panel needed its own name.
- `.soc-field span` is a descendant selector (0,1,1). A bare class (0,1,0) does
  **not** beat it — this has come back three times. Write
  `.soc-field span.my-class`.

---

## 9. Motion

**120 ms, and only on large planes.** `--theme-swap` animates `background` and
`color` on containers so a theme change does not read as a page reload. Beyond
that the screen looks like it is hesitating.

- `transition: all` is forbidden — it makes every hover sluggish.
- `border-color` is not animated on tables — it shimmers.
- `@media (prefers-reduced-motion: reduce)` sets `--theme-swap: 0s`. WCAG 2.3.3:
  a full-screen colour transition is exactly what that setting exists to remove.

No loading spinners where a real state can be shown instead. No skeletons that
imply data is arriving when the request already failed.

---

## 10. Mark, logo, imagery

**The wordmark is the logo.** `MENATER` set in Archivo Black, uppercase,
tracking `-0.01em`. It is legible at every size, it needs no explanation, and it
is the only element that will be recognised before the brand is known.

**The mark is the register:** five ticks, the middle one a stub rather than a
full bar. It is the product's first principle drawn literally — *a missing value
keeps its place instead of being omitted*. Absence sits at the centre, so the
mark stays symmetric: the gap is the composition, not a defect in it.

| The choice | The reason |
|---|---|
| **Angular**, never rounded | Circular logo shapes activate softness; angular ones activate hardness and durability, and read as more premium |
| **Symmetric** | Asymmetry raises perceived *excitement*, and pays only for brands whose personality is excitement. This one's is competence — which is why the earlier cut-corner mark was dropped after it was proposed |
| **Descriptive of the method**, never of the threat | Descriptive logos raise brand evaluations — but the effect *reverses* for categories carrying negative associations, and security is one. That is the rule behind §12's refusal of the shield and the padlock; it is not a matter of taste |
| **Moderately elaborate, natural** | High-recognition logos are natural, harmonious and moderately elaborate. This one reads as a scale, a signal, a row of records — not as pure geometry, which is the weakest position for a brand nobody has met |
| **No colour of its own** | It ships as `fill="currentColor"`, and `.soc-logo-sign` sets `color: var(--accent)`. One file follows all six themes; a hex inside the SVG would follow none of them |

**The geometry exists once.** `MARK_BARS` in
`dashboard/src/components/Mark.tsx`. The React component renders it and
`dashboard/src/theme/favicon.ts` builds the browser-tab icon from the same
array — writing the rectangles twice would give the mark and its own favicon two
different drawings, silently, because neither copy fails when they disagree. A
test compares them.

**The tab icon follows the theme too.** Everything inside the page takes its
colour from the tokens for free; the tab is the one surface CSS cannot reach, so
`applyTheme()` repaints it from `THEME_SWATCHES` — no fourth copy of the
palette. `dashboard/public/favicon.svg` is the slate version, shown between the
first paint and React mounting, and a test keeps it in step with the generated
one. **The shape never changes**: people find their tab by its icon.

**Clear space** around the lockup: the cap-height of the M on all four sides.
**Minimum width** 88 px; below that, the mark alone — and the mark travels
without the word only once the word is recognised. Only three icons are
universally understood (home, print, search), and this is not one of them.

**Placement is settled, not a preference:** top left, and clickable to the
console's home. Logos there are remembered 89% more often than on the right,
and get someone home in one click six times more often than centred ones.

**Imagery.** Screenshots of the real console, in `grayed`, with real-shaped
data — never stock photography, never a hooded figure, never a padlock, never a
world map with arcs. The product's own screens are the strongest asset it has;
a generic security illustration would say the opposite of everything in §2.

**Iconography.** Line icons, 1.5 px stroke, drawn on a 20 px grid, currentColor.
No emoji in product surfaces. No filled icon sets — they compete with the risk
pills for the same pre-attentive channel.

---

## 11. Applications

| Surface | Rule |
|---|---|
| **Favicon** | The cut-corner mark, `--accent` on `--hero`. Fixed for the product's life: users find a tab by its icon |
| **`<title>`** | `MENATER — Security Operations`. Short, no tagline |
| **Social / OG card** | `grayed` ground, the wordmark, one sentence from §2. No screenshot mosaic |
| **README** | Wordmark, then the two halves in one sentence, then `docker compose up`. The install command is the hero — a security console proves itself by running |
| **Slack blocks** | Written by the engine, so not in an i18n catalogue. Same voice: name the alert, name what is asked, name who is asked |
| **Docs** | Tables over prose wherever a rule has more than two cases. It is already the house style; it is now the brand's |

---

## 12. The "never" list

The anti-*vibecoded* checklist. NN/g's 2026 finding is that polish has stopped
being a quality signal — audiences now ask "whether a person cared enough to
design it themselves". These are the tells that answer *no*:

- Purple-to-blue gradients. Any gradient on a surface.
- Glassmorphism, blur, translucent panels over content.
- Radii above 8 px on anything that is not a dot.
- Emoji as icons, in product surfaces or in headings.
- A "hero section" with a floating 3D shape.
- Marketing superlatives: *seamless*, *powerful*, *effortless*, *AI-powered*,
  *next-generation*, *supercharge*.
- Fake dashboards in screenshots. Fabricated metrics on a landing page.
- Green as a resting state. **A green that was never earned is the single worst
  thing this design can do** — it is the exact defect the Tracking tab exists to
  expose, reproduced in the marketing.
- More than one accent on a screen.
- A colour that carries meaning with no word beside it.
- Decorative animation on load.
- Stock photography of any kind.

And the positive form, which matters more: **leave the decision visible.** The
comments in `themes.css` that explain why Attck's red was lowered, why `--hero`
is an inset, why Punk's accent was darkened — that is the evidence a person was
here. It is currently readable only by someone who opens the CSS. Surface it:
the brand page, the Guide tab, and the commit messages are all places where a
shown decision is worth more than a claim of quality.

---

## 13. Accessibility floor

Not a section of the brand — a condition of it.

| Rule | Source |
|---|---|
| Text and interactive elements ≥ 4.5:1; large text and non-text ≥ 3:1 | WCAG 1.4.3, 1.4.11 |
| Colour never alone | WCAG 1.4.1 |
| Interactive motion disableable; `prefers-reduced-motion` honoured | WCAG 2.3.3 |
| Sizes in `rem`; the browser's font setting is respected | — |
| Touch targets ≥ 44 px; form fields ≥ 16 px to avoid iOS auto-zoom | — |
| `color-scheme` follows the theme, or Acme keeps black scrollbars | — |
| Every state reachable and visible by keyboard | WCAG 2.4.7 |

---

## 14. Known drift, to be closed

Written down rather than quietly tolerated. Measured on `dashboard/src/styles.css`:

**Closed — September 2026.** Kept here as the record of what was wrong and how
it was closed, because a drift that is fixed silently comes back.

| Drift | Was | Now |
|---|---|---|
| Type sizes | 32 distinct values across the two sheets | The 8 `rem` steps of §6, plus the two documented `px` exceptions |
| Spacing | `1 3 5 9 14 18 22 26 28 30 34 38 46 60 px` among the rest | The 2 px scale of §7 |
| Radius | `2 3 4 5 6 7 8 10 12 14 999 px` | `var(--radius)`, `50%`, and the switch capsule |
| CSS comments | 258 lines of French | English, reasoning preserved in full |
| `index.html` | `lang="fr"`, and a comment describing a bilingual product | `lang="en"`, and the comment says why the catalogue machinery is kept |

None of these was a bug: the console worked throughout. All of them were the
same defect — a variation that carries no meaning, which is the definition of
extraneous cognitive load. **It was closed in one pass rather than
opportunistically**, so the next hardcoded value is immediately visible as an
error. `npm run typecheck` clean, `npm run test` 775 passed.

**What was deliberately not touched**, and why it is not drift:

- the three `font-size: 16px` on form inputs, and the SVG label sizes (§6);
- `.vp-switch-track`'s capsule, and the bubbles' dropped corner (§7);
- `VulnPipe/`'s own engine sheets, which are a separate service.

---

## 15. How to use this file

**This file governs what the console looks like. [CLARITY.md](CLARITY.md)
governs whether it can be understood** — what competes for attention, what may
be folded away, and how to find the places where the answer is currently wrong.
Adding a colour or a size is this file; adding a paragraph, a panel or a screen
is that one.

- **Adding a colour?** It goes in all six themes, or it does not go in.
- **Adding a size or a space?** Use a step from §6/§7. If none fits, the answer
  is almost always that the design is wrong, not that the scale is short.
- **Adding a class?** Check the prefix is free — `grep` before you write. §8.
- **Adding a word to the interface?** §4, and it goes in the i18n catalogue.
- **Changing a rule in here?** Change it here first, with the reason. A rule
  with no reason is a rule the next person will delete.

---

## Sources

The principles above are not preferences. Where they come from:

- Nielsen Norman Group — [Trustworthiness in Web Design: 4 Credibility Factors](https://www.nngroup.com/articles/trustworthy-design/)
- Nielsen Norman Group — [The Aesthetic-Usability Effect](https://www.nngroup.com/articles/aesthetic-usability-effect/)
- Nielsen Norman Group — [Minimize Cognitive Load to Maximize Usability](https://www.nngroup.com/articles/minimize-cognitive-load/)
- Nielsen Norman Group — [Dashboards: Making Charts and Graphs Easier to Understand](https://www.nngroup.com/articles/dashboards-preattentive/)
- Nielsen Norman Group — [Handmade Designs: The New Trust Signal](https://www.nngroup.com/articles/handmade-designs/)
- W3C — [Understanding SC 1.4.1: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- W3C — [Understanding SC 2.3.3: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- GOV.UK Design System — [Colour](https://design-system.service.gov.uk/styles/colour/)
- U.S. Web Design System — [Typesetting tokens](https://designsystem.digital.gov/design-tokens/typesetting/overview/)
- Refactoring UI — [Building Your Color Palette](https://www.refactoringui.com/previews/building-your-color-palette)

On the mark specifically (§10):

- Jiang, Gorn, Galli & Chattopadhyay — [Does Your Company Have the Right Logo? Circular- and Angular-Logo Shapes](https://academic.oup.com/jcr/article-abstract/42/5/709/1855577), *Journal of Consumer Research*
- Luffarelli, Mukesh & Mahmood — [Let the Logo Do the Talking: Logo Descriptiveness and Brand Equity](https://journals.sagepub.com/doi/abs/10.1177/0022243719845000), *Journal of Marketing Research* — and its [HBR summary](https://hbr.org/2019/09/a-study-of-597-logos-shows-which-kind-is-most-effective)
- Luffarelli, Stamatogiannakis & Yang — [The Visual Asymmetry Effect](https://journals.sagepub.com/doi/10.1177/0022243718820548), *Journal of Marketing Research*
- Henderson & Cote — [Guidelines for Selecting or Modifying Logos](https://journals.sagepub.com/doi/10.1177/002224299806200202), *Journal of Marketing*
- Nielsen Norman Group — [Icon Usability](https://www.nngroup.com/articles/icon-usability/)
- Nielsen Norman Group — [Website Logo Placement for Maximum Brand Recall](https://www.nngroup.com/articles/logo-placement-brand-recall/)
- Nielsen Norman Group — [Centered Logos Hurt Website Navigation](https://www.nngroup.com/articles/centered-logos/)
