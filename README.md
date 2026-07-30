# c7n-policies

Cloud Custodian policies.

## `flatten_repo.py` — repository → single LLM-context file

`flatten_repo.py` flattens a git repository into **one** self-contained text
file designed to be pasted into an LLM as context. It has no third-party
dependencies (Python 3.8+ standard library only).

### What it produces

The output document is optimized so a model can understand a codebase in a
single pass:

- **Repository summary** — name, remote, branch, HEAD commit and totals.
- **Directory tree** — an ASCII map of the included files.
- **Table of contents** — every file with its line count and size.
- **File contents** — each file wrapped in a fenced block that records its
  path, size and language, with a self-widening fence so files that themselves
  contain <code>```</code> still parse unambiguously.

### What it includes / excludes

- Uses `git ls-files`, so **`.gitignore` is honored automatically** and only
  tracked source is included.
- Skips **binary files**, **oversized files** (`--max-file-bytes`, default
  500 KB), common **lockfiles**, and heavy directories such as `node_modules`,
  `vendor`, `dist`, `.venv` and `__pycache__`.
- Every omission is reported in a **"Files skipped"** section so nothing
  silently disappears.
- Output is **deterministic** (sorted), making it diff- and cache-friendly.

### Usage

```bash
python flatten_repo.py                       # flatten the current repo
python flatten_repo.py /path/to/repo         # flatten another repo
python flatten_repo.py -o context.md         # choose the output file
python flatten_repo.py -o -                  # write to stdout
python flatten_repo.py --max-file-bytes 200000
python flatten_repo.py --include-untracked   # also include untracked files
python flatten_repo.py --include-lockfiles   # keep lockfiles in the output
python flatten_repo.py --exclude-dir docs    # exclude an extra directory
```

By default the file is written to `<repo-name>-context.md`.
