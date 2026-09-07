"""Assemble the presentation page, once per locale and once per delivery form.

    page.src.html    the page. English lives here, in the clear, because that
                     is where a diff is readable. `<!--SHOT:name-->` marks a
                     screenshot and `<!--LANGS-->` the language switcher.
    i18n/<loc>.json  the other locales, keyed against the same source.

Four outputs, two axes:

    index.html       English, static host, <img src="/shots/name.png">
    fr/index.html    French, same
    page.html        English, published Artifact: screenshots inlined as data
    page.fr.html     URIs, because an Artifact's CSP blocks external images

The catalogue is TYPED in the sense the console's is: a key on one side only
fails the build, and it fails naming the keys. A page half-translated at run
time is the defect this whole approach exists to avoid — so it is caught here,
on the machine of whoever added the string, and never on a reader's screen.
"""
import base64, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'page.src.html'
DEFAULT = 'en'

# The site is offered in these; `en` is the source, so it has no file.
LOCALES = {
    'en': {'name': 'English', 'og': 'en_US', 'path': '/',
           'file': 'index.html', 'artifact': 'page.html'},
    'fr': {'name': 'Français', 'og': 'fr_FR', 'path': '/fr',
           'file': 'fr/index.html', 'artifact': 'page.fr.html'},
}

ATTRS = ('content', 'alt', 'title', 'placeholder', 'aria-label')

# --------------------------------------------------------------------------
# Reading the source: which strings are translatable, and where they sit.
# --------------------------------------------------------------------------

def _element_span(src, at):
    """Given an index inside an open tag, return (open_start, inner_start,
    inner_end, close_end) for that element, counting nested same-name tags."""
    open_start = src.rindex('<', 0, at)
    name = re.match(r'<([a-zA-Z][\w-]*)', src[open_start:]).group(1)
    inner_start = src.index('>', at) + 1
    depth, i = 1, inner_start
    open_re = re.compile(r'<%s[\s>]' % re.escape(name), re.I)
    close = '</%s>' % name
    while depth:
        nxt_close = src.find(close, i)
        if nxt_close < 0:
            raise SystemExit('unclosed <%s> around: %s' % (name, src[open_start:open_start + 80]))
        m = open_re.search(src, i, nxt_close)
        if m:
            depth += 1
            i = m.end()
        else:
            depth -= 1
            i = nxt_close + len(close)
    return open_start, inner_start, nxt_close, i


def read_source():
    """-> (source text, {key: english}, [(kind, key, start, end)] slices)."""
    src = SRC.read_text()
    en, slices = {}, []

    for m in re.finditer(r'data-i18n="([\w.\-]+)"', src):
        key = m.group(1)
        _, inner_start, inner_end, _ = _element_span(src, m.start())
        text = src[inner_start:inner_end].strip()
        # One key may dress several elements — a nav entry and the running
        # label of the section it points at are the same string, and giving
        # them two keys would let them drift. Two DIFFERENT texts under one
        # key is the real conflict, and that still fails.
        if en.get(key, text) != text:
            raise SystemExit('key %s used for two different strings' % key)
        en[key] = text
        slices.append(('text', key, inner_start, inner_end))

    for attr in ATTRS:
        for m in re.finditer(r'data-i18n-%s="([\w.\-]+)"' % re.escape(attr), src):
            key = m.group(1)
            # Only the OPEN TAG is needed here, which is what lets this work
            # on a void element: <meta> has no closing tag to look for.
            open_start = src.rindex('<', 0, m.start())
            tag = src[open_start:src.index('>', m.start()) + 1]
            v = re.search(r'(?<![\w-])%s="([^"]*)"' % re.escape(attr), tag)
            if not v:
                raise SystemExit('data-i18n-%s="%s" on a tag with no %s=""' % (attr, key, attr))
            if en.get(key, v.group(1)) != v.group(1):
                raise SystemExit('key %s used for two different strings' % key)
            en[key] = v.group(1)
            slices.append(('attr', key, open_start + v.start(1), open_start + v.end(1)))

    # The strings the script writes into the page, under a `ui.` prefix.
    ui = re.search(r'<script type="application/json" id="ui-strings">(.*?)</script>', src, re.S)
    if not ui:
        raise SystemExit('the ui-strings block is gone')
    for k, v in json.loads(ui.group(1)).items():
        en['ui.' + k] = v

    slices.sort(key=lambda s: s[2])
    return src, en, slices, ui.span(1)


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
        missing = sorted(set(en) - set(cat))
        extra = sorted(set(cat) - set(en))
        if missing or extra:
            for k in missing:
                print('  %s: MISSING  %s' % (loc, k), file=sys.stderr)
            for k in extra:
                print('  %s: UNKNOWN  %s' % (loc, k), file=sys.stderr)
            raise SystemExit(
                '%s is out of step with the source: %d missing, %d unknown. '
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
        s = 'data:image/png;base64,' + b64
    else:
        s = '/shots/%s.png' % name
    return ('<figure class="shot">\n'
            '  <img data-shot="{n}" src="{s}" alt="{a}" width="2880" height="1800" '
            'loading="{l}" decoding="async">\n'
            '  <figcaption>{c}</figcaption>\n'
            '</figure>').format(n=name, s=s, a=alt.replace('"', '&quot;'),
                                l='eager' if caps[name]['eager'] else 'lazy', c=cap)


def switcher(loc):
    """Two links, and the current one is a span. The URL is the whole state:
    no cookie, no header sniffing, no redirect — a link somebody shares opens
    in the language they shared it in."""
    def label(meta, code):
        return ('<span class="l-long">%s</span><span class="l-short">%s</span>'
                % (meta['name'], code.upper()))

    out = ['<div class="langs">']
    for code, meta in LOCALES.items():
        if code == loc:
            out.append('<span aria-current="true" lang="%s" title="%s">%s</span>'
                       % (code, meta['name'], label(meta, code)))
        else:
            out.append('<a href="%s" hreflang="%s" lang="%s" title="%s" aria-label="%s" '
                       'data-lang-link data-href="%s">%s</a>'
                       % (meta['path'], code, code, meta['name'], meta['name'],
                          meta['path'], label(meta, code)))
    out.append('</div>')
    return '\n      '.join(out)


def render(src, slices, ui_span, cat, loc, caps, inline):
    parts, at = [], 0
    for kind, key, start, end in slices:
        parts.append(src[at:start])
        parts.append(cat[key])
        at = end
    parts.append(src[at:])
    out = ''.join(parts)

    ui = {k[3:]: v for k, v in cat.items() if k.startswith('ui.')}
    out = re.sub(r'(<script type="application/json" id="ui-strings">).*?(</script>)',
                 lambda m: m.group(1) + '\n' + json.dumps(ui, ensure_ascii=False, indent=2)
                 + '\n' + m.group(2), out, flags=re.S)

    out = out.replace('<!--LANGS-->', switcher(loc))
    out = re.sub(r'<!--SHOT:([\w-]+)-->',
                 lambda m: figure(m.group(1), caps, cat, inline), out)
    # The markers have done their job at build time; they are weight on the
    # wire and a second, stale copy of the key list in a shipped file.
    out = re.sub(r'\s+data-i18n(?:-[\w-]+)?="[\w.\-]+"', '', out)
    return out


def head(loc, description):
    alts = '\n'.join(
        '<link rel="alternate" hreflang="%s" href="https://menater.vercel.app%s">' % (c, m['path'])
        for c, m in LOCALES.items())
    return ('<!doctype html>\n'
            '<html lang="%s" data-palette="grayed">\n'
            '<head>\n'
            '<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            '<meta property="og:type" content="website">\n'
            '<meta property="og:locale" content="%s">\n'
            '<meta property="og:description" content="%s">\n'
            '<meta name="twitter:card" content="summary_large_image">\n'
            '%s\n'
            '<link rel="alternate" hreflang="x-default" href="https://menater.vercel.app/">\n'
            '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n'
            '<style>img{max-width:100%%}[hidden]{display:none!important}</style>\n'
            % (loc, LOCALES[loc]['og'],
               description.replace('&', '&amp;').replace('"', '&quot;'), alts))


def main():
    src, en, slices, ui_span = read_source()
    caps = json.loads((ROOT / 'shots' / 'captions.json').read_text())

    used = re.findall(r'<!--SHOT:([\w-]+)-->', src)
    missing_caps = [n for n in used if n not in caps]
    if missing_caps:
        raise SystemExit('no caption for: ' + ', '.join(missing_caps))

    # Captions and alt text are user-facing strings like any other, so they go
    # through the same check: they live beside the images, keyed `shot.<n>.*`.
    for n in used:
        en['shot.%s.alt' % n] = caps[n]['alt']
        en['shot.%s.cap' % n] = caps[n]['cap']

    cats = catalogues(en)

    print('%d translatable strings' % len(en))
    for loc, meta in LOCALES.items():
        cat = cats[loc]

        art = render(src, slices, ui_span, cat, loc, caps, inline=True)
        (ROOT / meta['artifact']).write_text(art)

        page = render(src, slices, ui_span, cat, loc, caps, inline=False)
        page = page.replace('<header class="top">',
                            '<meta property="og:title" content="MENATER">\n'
                            '</head>\n<body>\n<header class="top">', 1)
        full = head(loc, cat['meta.description']) + page + '\n</body>\n</html>\n'
        out = ROOT / meta['file']
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(full)

        print('  %-2s  %-16s %6.1f KB   %-14s %6.1f KB (inlined)'
              % (loc, meta['file'], len(full.encode()) / 1024,
                 meta['artifact'], (ROOT / meta['artifact']).stat().st_size / 1024))


main()
