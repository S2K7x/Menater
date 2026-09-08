"""Assemble the site: two pages, two languages, from one set of sources.

    page.src.html    the front page — the short version, no jargon
    docs.src.html    the documentation — the long one
    shared.css       one stylesheet, inlined into every output
    partials/        header, footer and script, shared by both pages
    i18n/<loc>.json  the other locales, keyed against the same sources

Placeholders a page source may use:

    <!--HEADER-->        the identity row (logo, languages, cross-link, theme)
    <!--CROSSLINK-->     inside the header: the OTHER page, per locale
    <!--LANGS-->         inside the header: the other language, same page
    <!--FOOTER-->        the footer
    <!--SCRIPT-->        the shared script and its string table
    <!--SHOT:name-->     a screenshot, captioned from shots/captions.json

The catalogue is TYPED in the sense the console's is: a key present on one
side only fails the build, and it fails naming the keys. A page half
translated at run time is the defect this whole approach exists to avoid — so
it is caught here, on the machine of whoever added the string, and never on a
reader's screen.

Only the front page gets an "inlined" variant (`page*.html`), for pasting into
a host that blocks external images. The documentation does not: it would add
two more 2.4 MB copies of the screenshots to the repository for a use nobody
has.
"""
import base64, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).parent
DEFAULT = 'en'

LOCALES = {
    'en': {'name': 'English', 'og': 'en_US', 'dir': ''},
    'fr': {'name': 'Français', 'og': 'fr_FR', 'dir': 'fr/'},
}

# `url` is what the language switcher and the cross-link point at; `cross`
# names the other page, so the header link is never a guess.
PAGES = {
    'landing': {'src': 'page.src.html', 'out': 'index.html', 'url': '',
                'cross': 'docs', 'inline': 'page%s.html'},
    'docs':    {'src': 'docs.src.html', 'out': 'docs/index.html', 'url': 'docs',
                'cross': 'landing', 'inline': None},
}

SITE = 'https://menater.vercel.app'
ATTRS = ('content', 'alt', 'title', 'placeholder', 'aria-label')


def url_of(page, loc):
    """`/`, `/fr`, `/docs`, `/fr/docs` — assembled the same way every time, so
    the switcher on the docs page cannot quietly send you to the front one."""
    u = '/' + LOCALES[loc]['dir'] + PAGES[page]['url']
    # `/fr/` would answer with a redirect to `/fr` under trailingSlash:false.
    # A redirect on the header's own navigation is a wasted round trip.
    return u.rstrip('/') or '/'


# --------------------------------------------------------------------------
# Reading a source: which strings are translatable, and where they sit.
# --------------------------------------------------------------------------

def _open_tag_end(src, at):
    return src.index('>', at) + 1


def _element_span(src, at):
    """Given an index inside an open tag, return (inner_start, inner_end) for
    that element, counting nested tags of the same name."""
    open_start = src.rindex('<', 0, at)
    name = re.match(r'<([a-zA-Z][\w-]*)', src[open_start:]).group(1)
    inner_start = _open_tag_end(src, at)
    depth, i = 1, inner_start
    open_re = re.compile(r'<%s[\s>]' % re.escape(name), re.I)
    close = '</%s>' % name
    while depth:
        nxt = src.find(close, i)
        if nxt < 0:
            raise SystemExit('unclosed <%s> around: %s' % (name, src[open_start:open_start + 80]))
        m = open_re.search(src, i, nxt)
        if m:
            depth += 1
            i = m.end()
        else:
            depth -= 1
            i = nxt + len(close)
    return inner_start, nxt


def scan(src, en, where):
    """Collect this source's translatable strings into `en` and return the
    slices to replace, sorted by position."""
    slices = []

    def claim(key, text):
        # One key may dress several elements — a nav entry and the heading it
        # points at are the same string, and two keys would let them drift.
        # Two DIFFERENT texts under one key is the real conflict.
        if en.get(key, text) != text:
            raise SystemExit('%s: key %r carries two different strings' % (where, key))
        en[key] = text

    for m in re.finditer(r'data-i18n="([\w.\-]+)"', src):
        a, b = _element_span(src, m.start())
        claim(m.group(1), src[a:b].strip())
        slices.append((m.group(1), a, b))

    for attr in ATTRS:
        for m in re.finditer(r'data-i18n-%s="([\w.\-]+)"' % re.escape(attr), src):
            # Only the OPEN TAG is needed, which is what lets this work on a
            # void element: <meta> has no closing tag to look for.
            open_start = src.rindex('<', 0, m.start())
            tag = src[open_start:_open_tag_end(src, m.start())]
            v = re.search(r'(?<![\w-])%s="([^"]*)"' % re.escape(attr), tag)
            if not v:
                raise SystemExit('%s: data-i18n-%s="%s" on a tag with no %s'
                                 % (where, attr, m.group(1), attr))
            claim(m.group(1), v.group(1))
            slices.append((m.group(1), open_start + v.start(1), open_start + v.end(1)))

    slices.sort(key=lambda s: s[1])
    return slices


# --------------------------------------------------------------------------
# The catalogue, checked before anything is written.
# --------------------------------------------------------------------------

def catalogues(en):
    out = {DEFAULT: en}
    for loc in LOCALES:
        if loc == DEFAULT:
            continue
        f = ROOT / 'i18n' / (loc + '.json')
        if not f.exists():
            raise SystemExit('missing catalogue: ' + str(f))
        cat = json.loads(f.read_text())
        missing, extra = sorted(set(en) - set(cat)), sorted(set(cat) - set(en))
        if missing or extra:
            for k in missing:
                print('  %s: MISSING  %s' % (loc, k), file=sys.stderr)
            for k in extra:
                print('  %s: UNKNOWN  %s' % (loc, k), file=sys.stderr)
            raise SystemExit(
                '%s is out of step with the sources: %d missing, %d unknown. '
                'A key added on one side only is exactly what this check is for.'
                % (loc, len(missing), len(extra)))
        out[loc] = cat
    return out


# --------------------------------------------------------------------------
# Rendering.
# --------------------------------------------------------------------------

def figure(name, caps, cat, inline):
    alt = cat.get('shot.%s.alt' % name, caps[name]['alt'])
    cap = cat.get('shot.%s.cap' % name, caps[name]['cap'])
    if inline:
        b64 = base64.b64encode((ROOT / 'shots' / (name + '.png')).read_bytes()).decode()
        src = 'data:image/png;base64,' + b64
    else:
        src = '/shots/%s.png' % name
    return ('<figure class="shot">\n'
            '  <img data-shot="{n}" src="{s}" alt="{a}" width="2880" height="1800" '
            'loading="{l}" decoding="async">\n'
            '  <figcaption>{c}</figcaption>\n'
            '</figure>').format(n=name, s=src, a=alt.replace('"', '&quot;'),
                                l='eager' if caps[name]['eager'] else 'lazy', c=cap)


def switcher(page, loc):
    """Two links to the SAME page in the other language, and the current one is
    a plain span. The URL is the whole state: no cookie, no header sniffing, no
    redirect — a link somebody shares opens in the language they shared it in."""
    def label(meta, code):
        return ('<span class="l-long">%s</span><span class="l-short">%s</span>'
                % (meta['name'], code.upper()))

    out = ['<div class="langs">']
    for code, meta in LOCALES.items():
        href = url_of(page, code)
        if code == loc:
            out.append('<span aria-current="true" lang="%s" title="%s">%s</span>'
                       % (code, meta['name'], label(meta, code)))
        else:
            out.append('<a href="%s" hreflang="%s" lang="%s" title="%s" aria-label="%s" '
                       'data-lang-link data-href="%s">%s</a>'
                       % (href, code, code, meta['name'], meta['name'], href, label(meta, code)))
    out.append('</div>')
    return '\n      '.join(out)


def crosslink(text, page, loc):
    """The header carries both cross-links; keep the one this page needs, drop
    the other, and point it at the right locale. Both English labels therefore
    live in the markup, where every other English string on this site lives."""
    other = PAGES[page]['cross']

    def one(m):
        if m.group(1) != other:
            return ''
        return m.group(0).replace('href="%s"' % m.group(2), 'href="%s"' % url_of(other, loc), 1)

    return re.sub(r'<a class="ghlink cross" data-cross="(\w+)" href="([^"]*)"[^>]*>.*?</a>\n?',
                  one, text, flags=re.S)


def render(page, loc, cat, parts, caps, inline):
    src = parts['src']
    out, at = [], 0
    for key, start, end in parts['slices']:
        out.append(src[at:start])
        out.append(cat[key])
        at = end
    out.append(src[at:])
    text = ''.join(out)

    ui = {k[3:]: v for k, v in cat.items() if k.startswith('ui.')}
    text = re.sub(r'(<script type="application/json" id="ui-strings">).*?(</script>)',
                  lambda m: m.group(1) + '\n' + json.dumps(ui, ensure_ascii=False, indent=2)
                  + '\n' + m.group(2), text, flags=re.S)

    text = text.replace('<!--LANGS-->', switcher(page, loc))
    text = crosslink(text, page, loc)
    text = re.sub(r'<!--SHOT:([\w-]+)-->', lambda m: figure(m.group(1), caps, cat, inline), text)
    # The markers have done their job; shipping them is weight on the wire and
    # a second, stale copy of the key list in a published file.
    return re.sub(r'\s+data-i18n(?:-[\w-]+)?="[\w.\-]+"', '', text)


def document(page, loc, body, css, description):
    alts = '\n'.join(
        '<link rel="alternate" hreflang="%s" href="%s%s">' % (c, SITE, url_of(page, c))
        for c in LOCALES)
    title = re.search(r'<title[^>]*>(.*?)</title>', body, re.S)
    esc = lambda s: s.replace('&', '&amp;').replace('"', '&quot;')
    head = (
        '<!doctype html>\n'
        '<html lang="%s" data-palette="grayed">\n'
        '<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<link rel="canonical" href="%s%s">\n'
        '<meta property="og:type" content="website">\n'
        '<meta property="og:locale" content="%s">\n'
        '<meta property="og:title" content="%s">\n'
        '<meta property="og:description" content="%s">\n'
        '<meta name="twitter:card" content="summary_large_image">\n'
        '%s\n'
        '<link rel="alternate" hreflang="x-default" href="%s/">\n'
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n'
        % (loc, SITE, url_of(page, loc), LOCALES[loc]['og'],
           esc(title.group(1).strip()), esc(description), alts, SITE))
    return head + _split_head(body, css) + '\n</body>\n</html>\n'


def _split_head(body, css):
    """The page source opens with its <title> and <meta description>; the rest
    is the document body. The stylesheet is inlined rather than linked: one
    request, and no chance of the page painting before its own colours."""
    at = body.index('<header class="top">')
    return (body[:at].rstrip() + '\n<style>\n' + css + '\n</style>\n</head>\n<body>\n'
            + body[at:].rstrip())


def main():
    css = (ROOT / 'shared.css').read_text().strip()
    partials = {n: (ROOT / 'partials' / (n + '.html')).read_text().strip()
                for n in ('header', 'footer', 'script')}
    caps = json.loads((ROOT / 'shots' / 'captions.json').read_text())

    en, built = {}, {}
    for page, meta in PAGES.items():
        src = (ROOT / meta['src']).read_text()
        for name, frag in partials.items():
            src = src.replace('<!--%s-->' % name.upper(), frag)

        used = re.findall(r'<!--SHOT:([\w-]+)-->', src)
        missing = [n for n in used if n not in caps]
        if missing:
            raise SystemExit('%s: no caption for %s' % (meta['src'], ', '.join(missing)))
        # Captions and alt text are user-facing strings like any other, so they
        # go through the same check, keyed beside the images they belong to.
        for n in used:
            en.setdefault('shot.%s.alt' % n, caps[n]['alt'])
            en.setdefault('shot.%s.cap' % n, caps[n]['cap'])

        slices = scan(src, en, meta['src'])
        built[page] = {'src': src, 'slices': slices}

    ui = re.search(r'<script type="application/json" id="ui-strings">(.*?)</script>',
                   partials['script'], re.S)
    if not ui:
        raise SystemExit('the ui-strings block is gone from partials/script.html')
    for k, v in json.loads(ui.group(1)).items():
        en['ui.' + k] = v

    cats = catalogues(en)
    print('%d translatable strings' % len(en))

    for page, meta in PAGES.items():
        for loc in LOCALES:
            cat = cats[loc]
            body = render(page, loc, cat, built[page], caps, inline=False)
            key = 'd.meta.description' if page == 'docs' else 'meta.description'
            full = document(page, loc, body, css, cat[key])
            out = ROOT / (LOCALES[loc]['dir'] + meta['out'])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(full)
            line = '  %-8s %-2s  %-18s %6.1f KB' % (page, loc, out.relative_to(ROOT),
                                                    len(full.encode()) / 1024)
            if meta['inline']:
                name = meta['inline'] % ('' if loc == DEFAULT else '.' + loc)
                inl = render(page, loc, cat, built[page], caps, inline=True)
                (ROOT / name).write_text(document(page, loc, inl, css, cat[key]))
                line += '   %-14s %6.1f KB (inlined)' % (name, (ROOT / name).stat().st_size / 1024)
            print(line)


main()
