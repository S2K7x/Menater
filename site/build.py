"""Assemble page.html (inlined) and index.html (file refs) from page.src.html."""
import base64, json, pathlib, re

src = pathlib.Path('page.src.html').read_text()
caps = json.loads(pathlib.Path('shots/captions.json').read_text())

HEAD = '''<!doctype html>
<html lang="en" data-palette="grayed">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="MENATER">
<meta property="og:description" content="A self-hosted SOC triage console with an LLM in the loop and a human on the trigger.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>img{max-width:100%}[hidden]{display:none!important}</style>
'''

def figure(name, inline):
    c = caps[name]
    if inline:
        b64 = base64.b64encode(pathlib.Path('shots', name + '.png').read_bytes()).decode()
        src_attr = 'data:image/png;base64,' + b64
    else:
        src_attr = 'shots/%s.png' % name
    return ('<figure class="shot">\n'
            '  <img data-shot="{n}" src="{s}" alt="{a}" width="2880" height="1800" '
            'loading="{l}" decoding="async">\n'
            '  <figcaption>{c}</figcaption>\n'
            '</figure>').format(n=name, s=src_attr, a=c['alt'],
                                l='eager' if c['eager'] else 'lazy', c=c['cap'])

def render(inline):
    return re.sub(r'<!--SHOT:([\w-]+)-->', lambda m: figure(m.group(1), inline), src)

missing = [n for n in re.findall(r'<!--SHOT:([\w-]+)-->', src) if n not in caps]
if missing:
    raise SystemExit('no caption for: ' + ', '.join(missing))

pathlib.Path('page.html').write_text(render(True))

standalone = render(False).replace('<header class="top">', '</head>\n<body>\n<header class="top">', 1)
pathlib.Path('index.html').write_text(HEAD + standalone + '\n</body>\n</html>\n')

print('page.html  %6.1f KB (artifact, inlined)' % (len(pathlib.Path('page.html').read_bytes()) / 1024))
print('index.html %6.1f KB (static host, %d image refs)'
      % (len(pathlib.Path('index.html').read_bytes()) / 1024,
         len(re.findall(r'src="shots/', pathlib.Path('index.html').read_text()))))
