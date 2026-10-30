#!/usr/bin/env python3
"""One-time MCP setup for an explicitly supplied isolated Pi config root."""

import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile

BLOCKED_TOOLS = {
    "mcp",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
}
TOKEN_ENV = "GITLAB_PERSONAL_ACCESS_TOKEN"


def merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge(target[key], value)
        else:
            target[key] = value


def replace_frontmatter_line(profile, key, value):
    lines = profile.splitlines()
    end = lines.index("---", 1)
    match = next((i for i, line in enumerate(lines[1:end], start=1) if line.startswith(f"{key}:")), None)
    if match is None:
        lines.insert(end, f"{key}: {value}")
    else:
        lines[match] = f"{key}: {value}"
    return "\n".join(lines) + "\n"


def set_profile(profile, tools, enabled):
    frontmatter_end = profile.find("\n---", 4)
    if not profile.startswith("---\n") or frontmatter_end < 0:
        raise SystemExit("bundled MR profile has invalid frontmatter")

    metadata = {line.partition(":")[0]: line.partition(":")[2].strip()
                for line in profile[:frontmatter_end].splitlines()[1:] if ":" in line}
    flags = [flag for flag in shlex.split(metadata.get("flags", "")) if flag != "--no-mcp"]
    if not enabled:
        flags.append("--no-mcp")
    denied_tools = [name.strip() for name in metadata.get("deny-tools", "").split(",") if name.strip()]
    denied_tools = list(dict.fromkeys([*denied_tools, *sorted(BLOCKED_TOOLS)]))
    denied_env = [name.strip() for name in metadata.get("deny-env", "").split(",")
                  if name.strip() and name.strip() != TOKEN_ENV]
    if not enabled:
        denied_env.append(TOKEN_ENV)
    profile = replace_frontmatter_line(profile, "tools", tools)
    profile = replace_frontmatter_line(profile, "flags", shlex.join(flags))
    profile = replace_frontmatter_line(profile, "deny-tools", ",".join(denied_tools))
    return replace_frontmatter_line(profile, "deny-env", ",".join(denied_env))


def approved_tools(manifest):
    if not isinstance(manifest, dict) or not isinstance(manifest.get("approvedReadOnlyTools"), list):
        raise SystemExit("GitLab manifest must contain an approvedReadOnlyTools array")
    names = manifest["approvedReadOnlyTools"]
    if any(not isinstance(name, str) for name in names):
        raise SystemExit("GitLab approved tool names must all be strings")
    if any(not re.fullmatch(r"mcp__gitlab__[A-Za-z0-9_-]+", name) for name in names):
        raise SystemExit("GitLab tool names must be exact qualified mcp__gitlab__ names")
    blocked_gitlab_names = {f"mcp__gitlab__{name}" for name in BLOCKED_TOOLS}
    if any(name in blocked_gitlab_names for name in names):
        raise SystemExit("generic MCP resource/proxy names cannot be approved")
    if len(set(names)) != len(names):
        raise SystemExit("GitLab approved tool names must not contain duplicates")
    return names


def atomic_write(path, content, mode=0o600):
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: initialize-mcp.py ISOLATED_PI_CONFIG_ROOT")

    root = Path(sys.argv[1]).expanduser().resolve()
    canonical_root = (Path.home() / ".pi" / "agent").resolve()
    if root == canonical_root or root in canonical_root.parents:
        raise SystemExit("refusing canonical root or its ancestors; supply a dedicated isolated config root")

    source_config = Path(__file__).parent
    template = json.loads((source_config / "mcp-servers.template.json").read_text(encoding="utf-8"))
    if not isinstance(template, dict) or not isinstance(template.get("mcpServers"), dict):
        raise SystemExit("MCP server template must contain an mcpServers object")

    root_manifest = root / "agents" / "config" / "gitlab-read-tools.json"
    manifest_path = root_manifest if root_manifest.exists() else source_config / "gitlab-read-tools.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    names = approved_tools(manifest)
    role_path = root / "agents" / "mr-babysitter.md"
    profile_source = role_path if role_path.exists() else source_config.parent / "mr-babysitter.md"
    bundled_profile = profile_source.read_text(encoding="utf-8")
    base_tools = "read,grep,find,inspect_context,inspect_change"
    profile_tools = ",".join([base_tools, *names])
    profile = set_profile(bundled_profile, profile_tools, bool(names))

    config_path = root / "mcp.json"
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise SystemExit("existing mcp.json must contain a JSON object")
        if "mcpServers" in config and not isinstance(config["mcpServers"], dict):
            raise SystemExit("existing mcp.json mcpServers must be an object")
    else:
        config = {}
    merge(config, template)
    if not isinstance(config.get("mcpServers"), dict):
        raise SystemExit("merged mcpServers must be an object")

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    role_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic_write(config_path, json.dumps(config, indent=2) + "\n")
    atomic_write(role_path, profile)
    print(f"Initialized isolated MCP config and MR profile under: {root}")


if __name__ == "__main__":
    main()
