#!/usr/bin/env python3
"""Flatten a git repository into a single file optimized as LLM context.

The goal of this tool is to produce ONE self-contained text file that gives a
language model the best possible understanding of a codebase in a single pass.

What "best context for an LLM" means here, and how we achieve it:

  * Only real source is included. We enumerate files with ``git ls-files`` so
    that ``.gitignore`` is honored automatically and untracked build junk,
    caches and secrets are left out.
  * Noise is stripped. Binary blobs, oversized files, and common lockfiles /
    vendored directories are skipped (with an explicit note) so the signal
    stays high and the token budget is spent on code that matters.
  * The structure is made explicit. A repository summary, a directory tree and
    a per-file table of contents come first, so the model can build a mental
    map before reading any code.
  * Every file is unambiguously delimited. Each file is wrapped in a fenced
    block that carries its path, size and language hint, so the model never
    guesses where one file ends and the next begins.
  * Output is deterministic. Files are emitted in sorted order, which keeps the
    result diff-friendly and cache-friendly.

The script has no third-party dependencies (Python 3.8+ standard library only)
and is safe to run on any git checkout::

    python flatten_repo.py                       # flatten the current repo
    python flatten_repo.py /path/to/repo         # flatten another repo
    python flatten_repo.py -o context.md         # choose the output file
    python flatten_repo.py --max-file-bytes 200000
    python flatten_repo.py --include-untracked    # also include untracked files
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #

# Files larger than this are skipped by default (kept out of the token budget).
DEFAULT_MAX_FILE_BYTES = 500_000

# Directory names that almost never help an LLM understand the project and that
# tend to be huge. These are skipped even when tracked by git.
DEFAULT_EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    ".idea",
    ".vscode",
    ".terraform",
}

# Lockfiles and generated manifests: kept out by default because they are large
# and low-signal, but their presence is still reported in the summary.
DEFAULT_EXCLUDE_FILES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "Pipfile.lock",
    "composer.lock",
    "Cargo.lock",
    "go.sum",
}

# Map file extensions (and a few exact names) to Markdown fence languages so the
# model gets correct syntax highlighting / tokenization hints.
EXT_TO_LANG = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".java": "java",
    ".kt": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".scala": "scala",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".ps1": "powershell",
    ".sql": "sql",
    ".r": "r",
    ".lua": "lua",
    ".pl": "perl",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".xml": "xml",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".md": "markdown",
    ".markdown": "markdown",
    ".rst": "rst",
    ".tf": "hcl",
    ".hcl": "hcl",
    ".dockerfile": "dockerfile",
    ".gradle": "groovy",
    ".groovy": "groovy",
    ".vue": "vue",
    ".proto": "protobuf",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".csv": "csv",
    ".env": "bash",
}

# Exact filenames (no useful extension) mapped to a language.
NAME_TO_LANG = {
    "Dockerfile": "dockerfile",
    "Makefile": "makefile",
    "makefile": "makefile",
    "Jenkinsfile": "groovy",
    "Vagrantfile": "ruby",
    "Gemfile": "ruby",
    "Rakefile": "ruby",
    ".gitignore": "gitignore",
    ".dockerignore": "gitignore",
    ".editorconfig": "ini",
}


# --------------------------------------------------------------------------- #
# Git helpers                                                                 #
# --------------------------------------------------------------------------- #


def run_git(repo: Path, *args: str) -> str:
    """Run a git command in ``repo`` and return stripped stdout ('' on error)."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def is_git_repo(repo: Path) -> bool:
    return run_git(repo, "rev-parse", "--is-inside-work-tree") == "true"


def list_tracked_files(repo: Path, include_untracked: bool) -> list[str]:
    """Return repo-relative paths of tracked (and optionally untracked) files."""
    args = ["ls-files", "--cached"]
    if include_untracked:
        # Add files that are not tracked yet but are not ignored either.
        args = ["ls-files", "--cached", "--others", "--exclude-standard"]
    out = run_git(repo, *args)
    files = [line for line in out.splitlines() if line]
    return sorted(set(files))


def gather_repo_metadata(repo: Path) -> dict[str, str]:
    """Collect lightweight git metadata to orient the reader."""
    return {
        "name": repo.resolve().name,
        "branch": run_git(repo, "rev-parse", "--abbrev-ref", "HEAD") or "(unknown)",
        "commit": run_git(repo, "rev-parse", "--short", "HEAD") or "(unknown)",
        "commit_subject": run_git(repo, "log", "-1", "--pretty=%s") or "(no commits)",
        "remote": run_git(repo, "config", "--get", "remote.origin.url") or "(none)",
        "total_commits": run_git(repo, "rev-list", "--count", "HEAD") or "0",
    }


# --------------------------------------------------------------------------- #
# File inspection                                                             #
# --------------------------------------------------------------------------- #


def language_for(path: str) -> str:
    """Best-effort Markdown fence language for a given file path."""
    name = os.path.basename(path)
    if name in NAME_TO_LANG:
        return NAME_TO_LANG[name]
    ext = os.path.splitext(name)[1].lower()
    return EXT_TO_LANG.get(ext, "")


def looks_binary(data: bytes) -> bool:
    """Heuristic: a NUL byte, or a high ratio of non-text bytes, means binary."""
    if b"\x00" in data:
        return True
    if not data:
        return False
    # Bytes that are typically found in text (printable ASCII + common whitespace).
    text_bytes = bytes(range(0x20, 0x7F)) + b"\n\r\t\f\b"
    nontext = data.translate(None, text_bytes)
    return len(nontext) / len(data) > 0.30


def read_text_file(full_path: Path) -> str | None:
    """Return decoded text, or ``None`` when the file looks binary/unreadable."""
    try:
        raw = full_path.read_bytes()
    except OSError:
        return None
    if looks_binary(raw):
        return None
    # Decode leniently: real source is almost always UTF-8, and replacing the
    # rare stray byte is better than dropping an otherwise useful file.
    return raw.decode("utf-8", errors="replace")


def fence_for(content: str) -> str:
    """Pick a code-fence that is guaranteed not to collide with the content.

    If a file itself contains ``` sequences (e.g. a Markdown file), we grow the
    fence so the block still parses unambiguously.
    """
    longest = 0
    run = 0
    for ch in content:
        if ch == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return "`" * max(3, longest + 1)


# --------------------------------------------------------------------------- #
# Directory tree rendering                                                    #
# --------------------------------------------------------------------------- #


def build_tree(paths: list[str]) -> str:
    """Render an ASCII directory tree from a flat list of relative paths."""
    root: dict = {}
    for path in paths:
        node = root
        for part in path.split("/"):
            node = node.setdefault(part, {})

    lines: list[str] = []

    def walk(node: dict, prefix: str) -> None:
        # Directories first, then files; each group alphabetically.
        entries = sorted(node.items(), key=lambda kv: (not bool(kv[1]), kv[0].lower()))
        for i, (name, child) in enumerate(entries):
            last = i == len(entries) - 1
            connector = "└── " if last else "├── "
            suffix = "/" if child else ""
            lines.append(f"{prefix}{connector}{name}{suffix}")
            if child:
                walk(child, prefix + ("    " if last else "│   "))

    walk(root, "")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Token estimation                                                            #
# --------------------------------------------------------------------------- #


def estimate_tokens(char_count: int) -> int:
    """Rough token estimate (~4 characters per token for English/code)."""
    return char_count // 4


def human_bytes(n: float) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


# --------------------------------------------------------------------------- #
# Core                                                                        #
# --------------------------------------------------------------------------- #


def flatten(
    repo: Path,
    max_file_bytes: int,
    exclude_dirs: set[str],
    exclude_files: set[str],
    include_untracked: bool,
) -> str:
    """Produce the flattened, LLM-optimized representation of ``repo``."""
    meta = gather_repo_metadata(repo)
    all_files = list_tracked_files(repo, include_untracked)

    included: list[tuple[str, str, int]] = []  # (path, content, size_bytes)
    skipped: list[tuple[str, str]] = []  # (path, reason)

    for rel in all_files:
        parts = set(rel.split("/"))
        if parts & exclude_dirs:
            skipped.append((rel, "excluded directory"))
            continue
        if os.path.basename(rel) in exclude_files:
            skipped.append((rel, "lockfile / generated"))
            continue

        full = repo / rel
        try:
            size = full.stat().st_size
        except OSError:
            skipped.append((rel, "unreadable"))
            continue

        if size > max_file_bytes:
            skipped.append((rel, f"too large ({human_bytes(size)})"))
            continue

        content = read_text_file(full)
        if content is None:
            skipped.append((rel, "binary"))
            continue

        included.append((rel, content, size))

    return render(meta, included, skipped, repo)


def render(
    meta: dict[str, str],
    included: list[tuple[str, str, int]],
    skipped: list[tuple[str, str]],
    repo: Path,
) -> str:
    """Assemble the final document from collected files and metadata."""
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    total_chars = sum(len(c) for _, c, _ in included)
    total_bytes = sum(s for _, _, s in included)
    total_lines = sum(c.count("\n") + 1 for _, c, _ in included)

    out: list[str] = []
    w = out.append

    # --- Preamble / instructions to the model ------------------------------ #
    w(f"# Repository context: {meta['name']}")
    w("")
    w(
        "This file is a flattened snapshot of a git repository, generated for "
        "use as LLM context. It concatenates every relevant source file into a "
        "single document. Each file is delimited by a `FILE:` marker and wrapped "
        "in a fenced code block that records its path, size and language."
    )
    w("")

    # --- Repository summary ------------------------------------------------- #
    w("## Repository summary")
    w("")
    w(f"- **Name:** {meta['name']}")
    w(f"- **Remote:** {meta['remote']}")
    w(f"- **Branch:** {meta['branch']}")
    w(f"- **HEAD commit:** {meta['commit']} — {meta['commit_subject']}")
    w(f"- **Total commits:** {meta['total_commits']}")
    w(f"- **Generated:** {generated_at}")
    w(f"- **Files included:** {len(included)}")
    w(f"- **Files skipped:** {len(skipped)}")
    w(
        f"- **Total size:** {human_bytes(total_bytes)} "
        f"({total_lines:,} lines, ~{estimate_tokens(total_chars):,} tokens)"
    )
    w("")

    # --- Directory tree ----------------------------------------------------- #
    w("## Directory structure")
    w("")
    w("```")
    w(f"{meta['name']}/")
    tree = build_tree([p for p, _, _ in included])
    w(tree if tree else "(no files)")
    w("```")
    w("")

    # --- Table of contents -------------------------------------------------- #
    w("## Files included")
    w("")
    for path, content, size in included:
        lines = content.count("\n") + 1
        w(f"- `{path}` — {lines} lines, {human_bytes(size)}")
    w("")

    if skipped:
        w("## Files skipped")
        w("")
        w("The following tracked files were omitted to keep the context focused:")
        w("")
        for path, reason in skipped:
            w(f"- `{path}` — {reason}")
        w("")

    # --- File contents ------------------------------------------------------ #
    w("## File contents")
    w("")
    for path, content, size in included:
        lang = language_for(path)
        lines = content.count("\n") + 1
        fence = fence_for(content)
        w(f"### FILE: {path}")
        w("")
        w(f"_{lines} lines · {human_bytes(size)}_")
        w("")
        w(f"{fence}{lang}")
        # Ensure the content ends with exactly one newline before the fence.
        w(content.rstrip("\n"))
        w(fence)
        w("")

    w("<!-- End of repository context -->")
    w("")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Flatten a git repository into a single LLM-optimized file.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "repo",
        nargs="?",
        default=".",
        help="Path to the git repository to flatten.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="Output file path. Defaults to '<repo-name>-context.md'. "
        "Use '-' to write to stdout.",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=DEFAULT_MAX_FILE_BYTES,
        help="Skip files larger than this many bytes.",
    )
    parser.add_argument(
        "--include-untracked",
        action="store_true",
        help="Also include untracked (but non-ignored) files.",
    )
    parser.add_argument(
        "--include-lockfiles",
        action="store_true",
        help="Include lockfiles / generated manifests that are skipped by default.",
    )
    parser.add_argument(
        "--exclude-dir",
        action="append",
        default=[],
        metavar="NAME",
        help="Additional directory name to exclude (repeatable).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    repo = Path(args.repo).expanduser()
    if not repo.exists():
        print(f"error: path does not exist: {repo}", file=sys.stderr)
        return 2
    if not is_git_repo(repo):
        print(f"error: not a git repository: {repo}", file=sys.stderr)
        return 2

    exclude_dirs = set(DEFAULT_EXCLUDE_DIRS) | set(args.exclude_dir)
    exclude_files = set() if args.include_lockfiles else set(DEFAULT_EXCLUDE_FILES)

    document = flatten(
        repo=repo,
        max_file_bytes=args.max_file_bytes,
        exclude_dirs=exclude_dirs,
        exclude_files=exclude_files,
        include_untracked=args.include_untracked,
    )

    if args.output == "-":
        sys.stdout.write(document)
        return 0

    output_path = Path(
        args.output or f"{repo.resolve().name}-context.md"
    ).expanduser()
    output_path.write_text(document, encoding="utf-8")

    tokens = estimate_tokens(len(document))
    print(
        f"Wrote {output_path} "
        f"({human_bytes(len(document.encode('utf-8')))}, ~{tokens:,} tokens)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
