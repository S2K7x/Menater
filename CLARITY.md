# MENATER — Keeping it understandable

**[DESIGN.md](DESIGN.md) governs what the console looks like. This file governs
whether it can be understood.** They do not overlap: one is colour, type, space
and voice; this one is *what competes for attention, and what does not*.

Read it before changing any screen, and before adding one.

---

## 0. The sentence the whole file reduces to

> **Everything stays available. What changes is what competes for attention.**

Nothing here is about removing features, shortening text, or "simplifying". A
console that hides a failure to look calm is worse than a cluttered one — this
product exists to expose failures that show green elsewhere, and it must not
commit that fault against itself.

The move is always the same: keep the fact, demote the explanation.

---

## 1. Why this file exists

The console had one visual weight for everything. Every panel opened with a
spaced mono kicker, an Archivo Black headline sized like the page title, and a
paragraph of explanation. So:

- the Tracking tab, whose entire content was "nothing to report", carried three
  billboards;
- the Health tab carried five;
- the Code tab put **1 400 px of prose** between the launch button and the
  report;
- the Lookup tab explained itself **three times** before you could type;
- the Settings → Engines page ran to **5 013 px** of flat stacked blocks.

None of it was wrong. Each sentence was written at a different moment, by
someone looking at one screen, and each was true. **Duplication of intent is
invisible per-file and obvious on the rendered page** — which is why the method
in §7 measures screens instead of reading components.

The result of one pass, measured (content panels, 1280 px):

| Screen | Before | After |
|---|---|---|
| Code (idle) | 3 171 px | 2 047 px |
| Workflow | 3 914 px | 2 188 px |
| Lookup | 2 609 px | 1 400 px |
| Settings → Engines | 5 013 px | 2 001 px |
| Settings → Ingestion | 2 576 px | 1 360 px |
| Alerts, per row | ~120 px | ~70 px |

**No feature was removed in any of them.**

---

## 2. Three levels, and nothing between them

| Level | What it is | Where |
|---|---|---|
| 1 | The page title — one per screen | `PageHead`, or the case rule when a case is open |
| 2 | A section inside the page | Small display capitals, the size of a strong label |
| 3 | A block inside a section | Quieter still; at that depth the content is the message |

`.soc-panel.soc-page-head h2` is (0,2,1) against `.soc-panel h2` (0,1,1): the
page title wins **by specificity**, never by document order, which the next edit
to the stylesheet would silently change.

If a screen seems to need a fourth level, the screen is doing two jobs. Split
it, or accept that one of the two is secondary and demote it.

---

## 3. What may fold, and what may never

This is the rule the rest of the file serves. Get it wrong and the pass becomes
a lie.

### May fold — it EXPLAINS

A definition. A method note. A reservation about reliability. A how-to. A raw
log. Two audit hashes. An install procedure you run once on another machine. A
reference table. A list of published workflows. A source catalogue.

**Test:** you read it once in your life. Reading it again teaches you nothing.

### May never fold — it REPORTS

A state. A count. A failure. An incomplete-intelligence banner. An action
awaiting approval. A coverage hole. A security guarantee you re-read every time
you act on it (the password never leaves the browser).

**Test:** it can be different tomorrow, or someone acts on it today.

Filing a failure behind a silent fold reproduces exactly the defect the Tracking
tab exists to expose — **a failure that shows green**. If you are unsure which
side something falls on, it reports.

### Four obligations that come with folding

1. **Nothing is deleted.** Folded text is in the DOM and reachable by keyboard.
   "One click away" and "erased" look identical on a screenshot and are nothing
   alike for someone searching.
2. **A fold says what is inside.** `hint` carries the size — "412 characters",
   "5 steps", "two hashes", "12 fields". A fold you must open to learn whether
   it was worth opening saves nothing.
3. **A fold may be worth more than its contents.** The Lookup source catalogue
   does not say "7 sources", it says **"1 of 7 reachable"** — on an install with
   no keys that is the most useful sentence on the screen, because it says in
   advance that every answer will be *not asked* rather than *nothing found*.
4. **Abnormal opens itself.** Zero sources reachable, an unreachable engine, a
   configured tunnel: the fold opens. See §6.

### An explanation must survive out of context

It is read alone, by someone who clicked a small disc, without the sentence that
used to precede it. Rewrite it if it does not stand up.

---

## 4. The primitives — reach for these before writing anything

They live in `dashboard/src/components/Guidance.tsx` and are imported by **both
halves** of the application, VulnPipe included. A second implementation under a
`vp-` prefix would be two things to learn and two to keep in step.

| Primitive | Use it for | Notes |
|---|---|---|
| `PageHead` | The one title per screen, with the Guide link | Level 1 |
| `Explain` | The circled "i": a section's explanation, one click away | Pass `term="shadow"` to read a glossary entry instead of retyping it |
| `Term` | A hard WORD, explained where it appears | Dotted underline; the word itself is the target |
| `Fold` | A piece consulted sometimes | `defaultOpen` **opens and never closes** — see §8 |
| `SectionTabs` / `SectionPanel` | A tab too long for one page | Content is hidden, never unmounted |
| `soc-quiet` | Good news, or a null result, in one line | Add `soc-quiet-ok` for the green check — §6 |
| `soc-titled` | A heading and its disc, side by side | The disc is the heading's **sibling** — §8 |
| `NothingFound` | An empty result that has to say what it covered | The pattern generalises: an absence needs a scope |
| `SectionBoundary` | Anything lazily loaded | Keeps a chunk failure inside its tab |

**`Explain` vs `Term`:** `Term` dresses a word that is written on screen.
`Explain` attaches to a title, or to a value whose name is no longer written
anywhere. Both read the same catalogue; a definition exists once.

---

## 5. Words

- **Every user-facing string goes in a catalogue.** `src/i18n/console.ts` for
  the console, `src/i18n/dictionary.ts` for code analysis, `server/i18n.ts` for
  route answers. A typed catalogue refuses a key added on one side only — it
  cannot refuse a string that never asked it anything, which is how nine French
  strings survived the English-only migration.
- **English, everywhere, including strings the engine writes.** Node labels,
  guardrail messages, divergence details, database failure explanations. Those
  are the sentences read at the worst moment. (`server/engine/` still holds
  ~90 French ones — ROADMAP § 7.)
- **A pipeline identifier is never shown raw**, and a value outside its
  catalogue is rendered **as-is**, never as `undefined`. `t.handoff[x] ?? x`.
- **Vocabulary does not drift.** *Not asked* ≠ *nothing found*. *Watch-only
  mode* is what the interface calls `shadow_mode`; the Guide's search reads the
  glossary so the word people actually type still finds it.
- **Never fill a gap with a default.** Missing data is shown as missing: `—`,
  never `''`, never an invented plausible value.

---

## 6. Colour is a claim

The risk palette is the one thing an operator scanning forty rows must be able
to trust. Two rules follow.

**Green is earned, and grey is the tone of the undetermined.** Green does not
mean "nothing found", it means "everything was read and nothing found". Laid
over a partial or unknown coverage it reassures about a hole. The scan report
takes green only when coverage is known complete, orange when there is a gap,
**grey when coverage is unknown** — the first version of that very screen took
green by default on an unknown scan, rebuilding inside itself the defect it
exists to remove.

**A red nobody should act on is worse than no red.** The Workflow tab announced
"cut-over refused, 9 blocking divergences" on an install that was migrating from nothing — a
migration nobody was doing. The colour was right about the data and wrong about
the situation. **Check whether the question applies before showing the answer.**

Contrast is tooled, never judged by eye: `theme/themes.test.ts` computes the
WCAG ratios for all six themes.

---

## 7. The method — how these defects are actually found

Reading components does not find them. All six of these did.

### Measure screens, in the browser, with a number

```js
[...document.querySelectorAll('main section.soc-panel')]
  .filter(p => p.offsetParent !== null)
  .reduce((a, p) => a + p.getBoundingClientRect().height, 0)
```

Run it per tab and per sub-tab. The tall ones are the ones to look at, and the
number is what tells you whether the change worked.

### Never review an empty screen

Tracking and Workflow were blank on the test install — no database — and
reviewing them that way found nothing. Mounted with data of the right shape (a
throwaway preview page under `dashboard/`, deleted after) they gave up **four
defects in ten minutes**, including a run log that showed `ERROR` without the
reason it already held.

A preview page is three files' worth of imports and Vite serves it at
`/preview-x.html`. Delete it in the same session.

### Enumerate the screens you cannot reach

A screen that needs a model key, real code, a completed scan or a live database
is a screen no browser sweep covers. Nine French strings and a whole empty-state
defect lived there. **List them deliberately, or read the components.**

### `innerText` is the hiding test

It returns only *rendered* text. If a heading's `innerText` contains what you
believed was hidden, assistive technology reads it too — a closed popover that
is merely positioned off-flow is still in the accessible name.

```js
[...document.querySelectorAll('h1,h2,h3,th')]
  .filter(e => e.offsetParent && (e.innerText || '').length > 70)
```

Should return `[]` on every tab.

### The squint test

Blur the screen. The loudest thing must be the thing worth being loud. On
Alerts that is the "waiting on you" tile; on Code it is the launch button.

### Write the rule as a test

`readability.test.tsx`, `settings-readability.test.tsx`, `docs-panel.test.tsx`,
`nothing-found.test.tsx`, `trace-workflow.test.tsx`. They claim the boundary —
the raw log is folded, the incomplete-intelligence banner is not, a metric's
value is in the clear and its definition is not. Two of them read `styles.css`
directly, because jsdom applies no cascade.

**Claim the VALUE, not the header.** When the triage table went from eight
columns to five, the test asks for `critical`, `0.96` and `240 ms` — never for
the column titles. That is the only thing that separates a regrouping from a
deletion.

---

## 8. Traps that have already been paid for

| Trap | Rule |
|---|---|
| `.soc-field span` is (0,1,1); a bare modifier class is (0,1,0) and loses | **Name the element**: `.soc-field span.my-class`. This has cost the project three times; the third fix had already been *attempted* as a bare class and had never once applied |
| A rule appended at the end of `styles.css` lands after the `@media` blocks | A new rule goes **next to the one it modifies**. A stylesheet with media queries in the middle has no "end" |
| A shared element styled as `.parent .child` | Name **every** parent that reuses it, responsive rules included |
| `<details open={x}>` in React is half-controlled | React re-asserts it whenever the value changes, `false` included. `Fold` freezes the initial value at mount and treats the prop as a signal that **opens and never closes**. Every real call site is "open when this becomes true, asynchronously" |
| A closed popover positioned off-flow | Still rendered, so still in the accessible name. `:not([open]) … { display: none }` |
| "Checking" treated as "broken" | The console has four diagnostic states so the undetermined is not a failure |
| The same help printed once per component instance | The provider form renders twice, so its two help paragraphs appeared twice each. Invisible in the code, obvious on screen |
| A number that skips (`04, 05, 06, 07, 10`) | Number by **reading order**, and keep it stable under a filter |

The full table, with the story behind each, is in **CLAUDE.md**.

---

## 9. Checklist before you ship a screen change

1. Does the page still have exactly **one** level-1 title?
2. Is every new sentence a **report**? If it explains, it belongs behind
   `Explain` or a `Fold`.
3. Does every new fold **say what is inside**?
4. Does anything abnormal **open itself**?
5. Is every new string in a **catalogue**, in English?
6. Is the new class prefix **free**? `grep` before you write.
7. Did you **measure** the screen before and after?
8. Do headings and `<th>` still come back **empty** from the `innerText` sweep?
9. Does it hold at **390 px** and in a **dark** theme, with no horizontal
   overflow?
10. Is the rule you just applied **written as a test**?
11. `npm run typecheck && npm run test && npm run build`.
12. Did you record the decision in **ROADMAP.md**, and the trap in
    **CLAUDE.md**?

---

## 10. Deliberately not done — do not "fix" these

- **The triage table keeps its eight facts.** It shows five columns; severity
  sits inside *Alert*, confidence inside *AI decision*, dwell under *Received*.
  A column an analyst sorts on is not chrome.
- **The four MCP client configurations all stay, in full.** One is shown at a
  time. Offering one and calling the rest "similar" turns five minutes into an
  afternoon.
- **No per-user density preference.** That is C1.5, and it is a feature, not a
  cleanup.
- **No second navigation level.** Ten tabs in four groups, sub-tabs where a page
  is long — and no tab inside a tab inside a tab.
- **Form field help stays visible.** It is decision support at the moment of the
  decision, not background reading. What went behind the disc was help repeated
  identically per instance.

---

## Sources

The rules above are not preferences.

**Cognitive load and attention**

- Nielsen Norman Group — [Minimize Cognitive Load to Maximize Usability](https://www.nngroup.com/articles/minimize-cognitive-load/)
- Sweller — Cognitive Load Theory: intrinsic load is the subject, **extraneous
  load is the presentation**, and only the second can be removed
- CogniFit — [Working Memory, Screens, and the Science of Cognitive Load](https://blog.cognifit.com/working-memory-screens-and-the-science-of-cognitive-load/)

**Progressive disclosure**

- Interaction Design Foundation — [Progressive Disclosure](https://ixdf.org/literature/topics/progressive-disclosure)
- [Progressive Disclosure in Enterprise Design: Less Is More, Until It Isn't](https://medium.com/@theuxarchitect/progressive-disclosure-in-enterprise-design-less-is-more-until-it-isnt-01c8c6b57da9)

**Hierarchy, grouping, density**

- [The Squint Test](https://medium.com/@sifatrabbani_UX/the-squint-test-0677a08de848)
- Gestalt — [Law of Common Region](https://uxcel.com/blog/law-of-the-common-region-in-ux):
  layering regions works, and stops working when everything is boxed
- [Millers Law](https://lawsofux.com/millers-law/) and
  [why a menu does not need 7±2](https://stephaniewalter.design/blog/your-menu-doesnt-need-millers-7-plus-minus-2-rule/):
  the cost of ten visible tabs is a **decision** cost, not a memory one — so the
  remedy is categorisation, never amputation
- Linear — [A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh):
  not every element carries equal weight; navigation recedes, the task stays

**Implementation**

- [Controlled vs uncontrolled React components](https://whereisthemouse.com/both-controlled-and-uncontrolled-react-components)
- [All-caps headings and accessibility](https://www.boia.org/blog/all-caps-headings-are-they-bad-for-accessibility)
- WCAG 2.2 — [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)

---

**Changing a rule in here?** Change it here first, with the reason. A rule with
no reason is a rule the next person deletes.
