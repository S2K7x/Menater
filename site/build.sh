#!/bin/sh
# One source, four outputs — two locales × two delivery forms.
#
#   page.src.html   the page, English in the clear, with <!--SHOT:name--> where
#                   a screenshot goes and data-i18n="key" on what translates
#   i18n/fr.json    the French against the same keys. A key on one side only
#                   FAILS this build, naming it
#
#   index.html      English, static host: <img src="/shots/name.png">, so the
#   fr/index.html   French, same          HTML stays ~62 KB and the seven PNGs
#                                         are cached separately
#   page.html       English, published Artifact: screenshots inlined as data
#   page.fr.html    French, same           URIs, because an Artifact's CSP
#                                          blocks every external image
#
# Captions and alt text live in shots/captions.json, beside the images, and go
# through the same catalogue check under the keys shot.<name>.cap / .alt.
set -e
cd "$(dirname "$0")"
python3 build.py
