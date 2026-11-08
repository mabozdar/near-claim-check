#!/usr/bin/env python3
"""Inline styles.css, snapshot.js, lib.js, app.js into one standalone HTML (no sibling files needed)."""
import re, os
d = os.path.dirname(os.path.abspath(__file__))
rd = lambda f: open(os.path.join(d, f), encoding="utf-8").read()
def safe_js(js):
    js = re.sub(r"</(script)", r"<\\/\1", js, flags=re.I)
    return js.replace("<!--", "<\\!--")
html = rd("index.html")
html = html.replace('<link rel="stylesheet" href="styles.css">', "<style>\n" + rd("styles.css").replace("</", "<\\/") + "\n</style>")
for f in ["snapshot.js", "lib.js", "app.js"]:
    html = html.replace('<script src="%s"></script>' % f, "<script>\n" + safe_js(rd(f)) + "\n</script>")
assert 'src="' not in html and 'href="styles.css"' not in html
out = os.path.join(d, "NEAR-Claim-Check-Final.html")
open(out, "w", encoding="utf-8").write(html)
print(out, len(html))
