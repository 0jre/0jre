#!/usr/bin/env python3
"""Generate top-langs.svg from real repo data.

Aggregates language bytes across every repo the STATS_PAT token can see
(public + private), skipping vendored/generated paths so the numbers
reflect authored code, not imported dependencies.
"""
import os
import requests

TOKEN = os.environ["STATS_PAT"]
H = {"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github+json"}

EXCLUDE_DIRS = (
    "vendor/", "vendored/", "third_party/", "third-party/", "node_modules/",
    "dist/", "build/", "out/", "target/", ".next/", ".nuxt/", "coverage/",
    "generated/", "gen/", "proto/gen/", "fixtures/", "__snapshots__/",
)
EXCLUDE_FILES = ("package-lock.json", "yarn.lock", "pnpm-lock.yaml",
                 "cargo.lock", "go.sum", "poetry.lock", "gemfile.lock",
                 "composer.lock", "mix.lock", "package.json")

EXT_TO_LANG = {
    "ts": "TypeScript", "tsx": "TypeScript", "mts": "TypeScript",
    "js": "JavaScript", "jsx": "JavaScript", "mjs": "JavaScript", "cjs": "JavaScript",
    "py": "Python", "rs": "Rust", "go": "Go", "clj": "Clojure", "cljs": "Clojure",
    "java": "Java", "kt": "Kotlin", "rb": "Ruby", "php": "PHP", "cs": "C#",
    "cpp": "C++", "cc": "C++", "cxx": "C++", "c": "C", "h": "C", "hpp": "C++",
    "swift": "Swift", "m": "Objective-C", "scala": "Scala", "sh": "Shell",
    "bash": "Shell", "zsh": "Shell", "css": "CSS", "scss": "CSS", "less": "CSS",
    "html": "HTML", "vue": "Vue", "svelte": "Svelte", "sql": "SQL",
    "lua": "Lua", "dart": "Dart", "ex": "Elixir", "exs": "Elixir",
    "erl": "Erlang", "hs": "Haskell", "jl": "Julia", "r": "R",
    "dockerfile": "Dockerfile", "toml": "TOML", "yaml": "YAML", "yml": "YAML",
    "json": "JSON", "md": "Markdown", "lean": "Lean", "tla": "TLA+",
    "sol": "Solidity", "zig": "Zig", "nix": "Nix",
}
# languages that usually shouldn't headline a profile
DATA_LANGS = {"JSON", "YAML", "TOML", "Markdown", "HTML", "CSS"}

COLORS = {
    "TypeScript": "#3178c6", "JavaScript": "#f1e05a", "Python": "#3572A5",
    "Rust": "#dea584", "Go": "#00ADD8", "Clojure": "#db5855", "Java": "#b07219",
    "Kotlin": "#A97BFF", "Ruby": "#701516", "PHP": "#4F5D95", "C#": "#178600",
    "C++": "#f34b7d", "C": "#555555", "Swift": "#F05138", "Scala": "#c22d40",
    "Shell": "#89e051", "CSS": "#563d7c", "HTML": "#e34c26", "Vue": "#41b883",
    "Svelte": "#ff3e00", "SQL": "#e38c00", "Lua": "#000080", "Dart": "#00B4AB",
    "Elixir": "#6e4a7e", "Haskell": "#5e5086", "Julia": "#a270ba", "R": "#198CE7",
    "Dockerfile": "#384d54", "Lean": "#4C72C0", "TLA+": "#4b0079",
    "Solidity": "#AA6746", "Zig": "#ec915c", "Nix": "#7e7eff",
}


def all_repos():
    repos, page = [], 1
    while True:
        r = requests.get("https://api.github.com/user/repos", headers=H,
                         params={"per_page": 100, "page": page,
                                 "affiliation": "owner,collaborator,organization_member"})
        r.raise_for_status()
        repos += r.json()
        if len(r.json()) < 100:
            return repos
        page += 1


def repo_tree(repo):
    branch = repo["default_branch"] or "main"
    r = requests.get(
        f"https://api.github.com/repos/{repo['full_name']}/git/trees/{branch}",
        headers=H, params={"recursive": "1"})
    if r.status_code != 200:
        return []
    return r.json().get("tree", [])


def skipped(path):
    p = path.lower()
    if any(f"/{d}" in f"/{p}" or p.startswith(d) for d in EXCLUDE_DIRS):
        return True
    return p.rsplit("/", 1)[-1] in EXCLUDE_FILES


def collect():
    agg = {}
    for repo in all_repos():
        for node in repo_tree(repo):
            if node.get("type") != "blob" or skipped(node["path"]):
                continue
            ext = node["path"].rsplit(".", 1)
            lang = EXT_TO_LANG.get(ext[1].lower()) if len(ext) == 2 else None
            if node["path"].rsplit("/", 1)[-1].lower() == "dockerfile":
                lang = "Dockerfile"
            if not lang or lang in DATA_LANGS:
                continue
            agg[lang] = agg.get(lang, 0) + node.get("size", 0)
    return agg


def render(agg, path="top-langs.svg"):
    total = sum(agg.values()) or 1
    top = sorted(agg.items(), key=lambda x: -x[1])[:8]
    rows, y = [], 42
    for lang, size in top:
        pct = size / total * 100
        color = COLORS.get(lang, "#8b949e")
        bar_w = max(2, pct * 3.4)
        rows.append(
            f'<circle cx="16" cy="{y-4}" r="5" fill="{color}"/>'
            f'<text x="28" y="{y}" class="lang">{lang}</text>'
            f'<text x="250" y="{y}" class="pct">{pct:.1f}%</text>'
            f'<rect x="300" y="{y-9}" width="{bar_w:.0f}" height="8" rx="4" fill="{color}"/>')
        y += 26
    h = y + 14
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="640" height="{h}" viewBox="0 0 640 {h}">
<style>
  text {{ font-family: 'Segoe UI', Ubuntu, Sans-Serif; fill: #c9d1d9; }}
  .title {{ font-size: 16px; font-weight: 600; }}
  .lang {{ font-size: 13px; }}
  .pct  {{ font-size: 12px; fill: #8b949e; }}
</style>
<rect width="100%" height="100%" rx="6" fill="#0d1117" stroke="#30363d"/>
<text x="16" y="28" class="title">Most Used Languages</text>
{''.join(rows)}
</svg>'''
    with open(path, "w") as f:
        f.write(svg)
    print(svg)


if __name__ == "__main__":
    render(collect())
