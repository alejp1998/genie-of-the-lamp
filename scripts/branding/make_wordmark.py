"""Pixel wordmark for Genie of the Lamp, in the blocky style of Lyrebird's.

Glyphs are drawn on Lyrebird's grid (cap height 638, baseline -11, strokes
~127 units, 88-unit corner notches); outer contours run one way and holes the
other, so the default nonzero fill works. Writes the light and dark SVGs:

    python3 scripts/branding/make_wordmark.py docs/images
"""
import sys
from pathlib import Path

GLYPHS = {
    "A": "M61 -11V552H149V638H453V552H542V-11H414V246H188V-11ZM188 381H414V501H188Z",
    "D": "M61 -11V638H365V552H453V467H542V160H453V74H365V-11ZM188 125H326V211H414V416H326V501H188Z",
    "E": "M149 -11V74H61V552H149V638H453V552H542V416H414V501H188V381H365V246H188V125H414V211H542V74H453V-11Z",
    "F": "M61 -11V552H149V638H542V501H188V381H453V246H188V-11Z",
    "G": "M149 -11V74H61V552H149V638H453V552H542V416H414V501H188V125H414V246H276V331H542V74H453V-11Z",
    "H": "M61 -11V638H188V381H414V638H542V-11H414V246H188V-11Z",
    "I": "M61 -11V125H149V501H61V638H365V501H276V125H365V-11Z",
    "L": "M149 -11V74H61V638H188V125H414V211H542V74H453V-11Z",
    "M": "M61 -11V638H188V-11ZM414 -11V638H542V-11ZM188 416V552H276V416ZM326 416V552H414V416ZM237 297V467H365V297Z",
    "N": "M61 -11V638H188V-11ZM414 -11V638H542V-11ZM188 381V552H276V381ZM237 246V467H326V246ZM276 160V331H365V160ZM326 74V246H414V74Z",
    "O": "M149 -11V74H61V552H149V638H453V552H542V74H453V-11ZM188 125H414V501H188Z",
    "P": "M61 -11V552H149V638H453V552H542V297H453V211H188V-11ZM188 331H414V501H188Z",
    "T": "M237 -11V501H61V638H542V501H365V-11Z",
}
ADVANCE = {"I": 496}
DEFAULT_ADVANCE, SPACE, GAP = 673, 336, 70


def wordmark(text: str, fill: str) -> str:
    x, paths = 0, []
    for ch in text:
        if ch == " ":
            x += SPACE
            continue
        paths.append(f'    <path transform="translate({x},0)" d="{GLYPHS[ch]}"/>')
        x += ADVANCE.get(ch, DEFAULT_ADVANCE)
    width = x - GAP + 80
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -678 {width} 729" role="img" aria-label="{text}">\n'
            f'  <g fill="{fill}" transform="scale(1,-1)">\n' + "\n".join(paths) + "\n  </g>\n</svg>\n")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    for name, fill in (("light", "#3e617d"), ("dark", "#8fb4cc")):
        (out / f"genie-wordmark-{name}.svg").write_text(wordmark("GENIE OF THE LAMP", fill))
