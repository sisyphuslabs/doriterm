#!/usr/bin/env python3
"""Rebuilds apps/web/e2e/fonts/pinned-ui.woff2 and pinned-hangul.woff2.

    uv run --python 3.13 --with fonttools==4.68.0 --with brotli==1.2.1 python make-pinned-fonts.py

The two faces are test fixtures, not product fonts. They pin what the e2e suite measures: the UI's Latin text and
every Hangul syllable the suite can draw, so a Linux runner and a developer's Mac lay out the same boxes (#862).

- pinned-ui.woff2: Inter Variable 4.1, instantiated at opsz 14 / wght 400 and cut to the UI's Latin ranges.
- pinned-hangul.woff2: Noto Sans KR Regular, cut to every Hangul syllable in apps/web/e2e, apps/web/src and
  packages/ui/src, plus the compatibility jamo block. Conjoining jamo are left out: they only enter as IME input, whose
  composition box is counted in cells, so no test measures their ink.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys
import tempfile
import urllib.request

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]

SOURCES = {
    "InterVariable.ttf": (
        "https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.ttf",
        "4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf",
    ),
    "NotoSansKR-Regular.otf": (
        "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf",
        "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68",
    ),
}

# ASCII, Latin-1, general punctuation and currency, letterlike symbols, arrows, mathematical operators, miscellaneous
# technical, geometric shapes and ornamental dingbats, and the ligature block. The UI draws the shortcut chips from
# the arrows and the miscellaneous-technical block, and its ellipsis from general punctuation.
UI_UNICODES = (
    list(range(0x0020, 0x007F))
    + list(range(0x00A0, 0x0100))
    + list(range(0x2000, 0x2070))
    + list(range(0x2070, 0x20A0))
    + list(range(0x20A0, 0x20D0))
    + list(range(0x2100, 0x2150))
    + list(range(0x2190, 0x2200))
    + list(range(0x2200, 0x2300))
    + list(range(0x2300, 0x2400))
    + list(range(0x25A0, 0x2600))
    + list(range(0x2600, 0x27C0))
    + list(range(0xFB00, 0xFB07))
    + [0xFEFF, 0xFFFD]
)

# Hangul compatibility jamo; the syllables are collected from the suite below.
HANGUL_EXTRA = list(range(0x3130, 0x3190))

TREES = ["apps/web/e2e", "apps/web/src", "packages/ui/src"]
SUFFIXES = {".ts", ".tsx", ".css", ".html", ".json"}

# Specs print Hangul as escapes as often as literals (`printf '\uD55C\uAE00'`), so the scan reads both.
ESCAPED = re.compile(r"\\u\{([0-9A-Fa-f]{4,6})\}|\\u([0-9A-Fa-f]{4})")


def download(name: str) -> pathlib.Path:
    url, wanted = SOURCES[name]
    target = pathlib.Path(tempfile.gettempdir()) / name
    if target.exists():
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest == wanted:
            return target
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response:
        target.write_bytes(response.read())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != wanted:
        sys.exit(f"{target}: sha256 {digest} does not match {wanted}")
    return target


def hangul_syllables() -> list[int]:
    found: set[int] = set()
    for tree in TREES:
        for path in (REPO / tree).rglob("*"):
            if path.suffix not in SUFFIXES:
                continue
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            found.update(ord(char) for char in text if "\uAC00" <= char <= "\uD7A3")
            for match in ESCAPED.finditer(text):
                code = int(match.group(1) or match.group(2), 16)
                if 0xAC00 <= code <= 0xD7A3:
                    found.add(code)
    if not found:
        sys.exit("no Hangul syllables found in the e2e suite")
    print(f"{len(found)} Hangul syllables in the suite")
    return sorted(found)


def rename(font: TTFont, family: str, postscript: str) -> None:
    """Gives a modified face its own name, as the OFL asks of a derivative of a reserved name."""
    name = font["name"]
    for record in list(name.names):
        if record.nameID in (1, 16):
            name.setName(family, record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID == 2:
            name.setName("Regular", record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID == 4:
            name.setName(family, record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID == 6:
            name.setName(postscript, record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID in (18, 20, 21, 22):
            name.removeNames(nameID=record.nameID)


def subset(source: pathlib.Path, target: pathlib.Path, unicodes: list[int], family: str, postscript: str) -> None:
    # No timestamp recalculation on save, so the same sources and tool versions give the same bytes.
    font = TTFont(source, recalcTimestamp=False)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"opsz": 14, "wght": 400}, updateFontNames=False)
    options = Options()
    options.flavor = "woff2"
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_outline = True
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    rename(font, family, postscript)
    # A fixed timestamp, so rebuilding the same sources gives the same bytes.
    font["head"].modified = 0
    font.save(target)
    print(f"{target.name}: {target.stat().st_size} bytes")


def main() -> None:
    subset(download("InterVariable.ttf"), HERE / "pinned-ui.woff2", UI_UNICODES, "E2E UI", "E2EUI-Regular")
    subset(
        download("NotoSansKR-Regular.otf"),
        HERE / "pinned-hangul.woff2",
        hangul_syllables() + HANGUL_EXTRA,
        "E2E Hangul",
        "E2EHangul-Regular",
    )


if __name__ == "__main__":
    main()
