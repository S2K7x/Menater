#!/bin/sh
# One source, two outputs.
#
#   page.src.html   the page, with <!--SHOT:name--> where a screenshot goes
#   page.html       for the published Artifact: screenshots inlined as data
#                   URIs, because an Artifact's CSP blocks every external image
#   index.html      for a static host: <img src="shots/name.png">, so the HTML
#                   stays ~60 KB and the five PNGs are cached separately
#
# Captions and alt text live in shots/captions.json, beside the images.
set -e
cd "$(dirname "$0")"
python3 build.py
