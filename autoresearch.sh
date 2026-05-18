#!/usr/bin/env bash
set -euo pipefail
ROOT="/Users/kristjan.pikhof/.agents/skills/trekoon"
python3 - <<'PY'
from pathlib import Path
import re
root=Path('/Users/kristjan.pikhof/.agents/skills/trekoon')
files=[root/'SKILL.md', *sorted((root/'reference').glob('*.md'))]
total=0
for p in files:
    text=p.read_text()
    words=re.findall(r"\b\S+\b", text)
    n=len(words); total+=n
    print(f"METRIC words_{p.name.replace('.md','')}={n}")
print(f"METRIC total_words={total}")
# crude guardrail signal only; rubric scoring is separate
joined='\n'.join(p.read_text().lower() for p in files)
for key in ['recoveryrequired','task claim','--append','task done','blocked','subagent','--toon','wipe --yes']:
    print(f"METRIC guard_{key.replace(' ','_').replace('-','_')}={joined.count(key)}")
PY
