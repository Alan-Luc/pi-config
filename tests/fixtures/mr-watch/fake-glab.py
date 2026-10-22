#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
if os.environ.get("FAKE_GLAB_PID"):
    Path(os.environ["FAKE_GLAB_PID"]).write_text(str(os.getpid()))
with open(os.environ["GLAB_TRACE"], "a", encoding="utf-8") as trace:
    trace.write(json.dumps(args) + "\n")
if os.environ.get("FAKE_GLAB_DELAY"):
    time.sleep(float(os.environ["FAKE_GLAB_DELAY"]))
path = args[-1]
responses = json.loads(Path(os.environ["GLAB_RESPONSES"]).read_text())
key = path if path in responses else path.split("?", 1)[0]
if "sequences" in responses and key in responses["sequences"]:
    prior = 0
    if Path(os.environ["GLAB_TRACE"]).exists():
        for line in Path(os.environ["GLAB_TRACE"]).read_text().splitlines()[:-1]:
            recorded = json.loads(line)[-1]
            prior += recorded == path
    sequence = responses["sequences"][key]
    print(json.dumps(sequence[min(prior, len(sequence) - 1)]))
    raise SystemExit(0)
if key not in responses:
    print("unexpected fake API path: " + key, file=sys.stderr)
    raise SystemExit(1)
print(json.dumps(responses[key]))
