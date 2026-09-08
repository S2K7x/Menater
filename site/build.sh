#!/bin/sh
# The site: two pages, two languages, one set of sources.
#
#   page.src.html   the FRONT PAGE — the short version, plain words, no jargon
#   docs.src.html   the DOCUMENTATION — the long one, sixteen sections
#   shared.css      one stylesheet, inlined into every output
#   partials/       header, footer and script, shared by both pages
#   i18n/fr.json    the French, against the same keys. A key present on one
#                   side only FAILS this build, naming it
#
# Outputs, served by Vercel with cleanUrls:
#
#   index.html          →  /            docs/index.html     →  /docs
#   fr/index.html       →  /fr          fr/docs/index.html  →  /fr/docs
#
#   page.html, page.fr.html   the front page with its screenshots inlined as
#                             data URIs, for a host that blocks external
#                             images. The documentation has no such variant:
#                             it would add two more megabytes of duplicated
#                             screenshots for a use nobody has.
#
# Captions and alt text live in shots/captions.json, beside the images, and go
# through the same catalogue check under the keys shot.<name>.cap / .alt.
#
# After changing anything visual, run check.mjs — it measures contrast in all
# six palettes rather than trusting the look of it.
set -e
cd "$(dirname "$0")"
python3 build.py
