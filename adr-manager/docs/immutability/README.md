# ADR immutability via Git's content-addressable storage

This fork extends ADR-Manager so that Architectural Decision Records can be made
**immutable after they are accepted**, without introducing a new storage system.
It does this by leaning on the fact that **Git is already a content-addressable
object store**: every version of every file is kept forever, addressed by the
SHA-1 hash of its content (a *blob*).

The feature has three parts:

1. **Read/display ADR versions by their Git blob/commit SHA** (in the app).
2. **An append-only manifest** that indexes each ADR's versions by content hash
   and records lifecycle + cross-link metadata.
3. **CI enforcement + branch protection + signed commits** that make the
   immutability guarantee real on shared branches.

---

## 1. Content-addressable versions in the app

- `src/plugins/cas.js` computes the **Git blob SHA** of any content
  (`gitBlobSha`) and verifies content against an expected hash
  (`verifyContentHash`). The value is identical to `git hash-object` and to the
  SHA the GitHub API returns, so the app and Git agree on identity.
- `src/plugins/api.js` adds:
  - `loadFileCommitHistory(repo, branch, path)` — the commit history of one ADR,
  - `loadBlobBySha(repo, sha)` — read a blob directly by its content hash,
  - `loadRawFileAtRef(repo, ref, path)` — read an ADR at any commit.
- `src/components/EditorVersionHistory.vue` adds a **"Version History"** tab to
  the editor. It lists every commit that touched the current ADR, and for any
  selected version it shows the content, its **content hash (Git blob SHA)**, and
  whether that hash **matches the locked accepted version**.

Because each version is addressed by its hash, the original wording of an
accepted ADR is always retrievable and always verifiable — it cannot be silently
lost or altered.

## 2. The immutability manifest

`src/plugins/manifest.js` defines a single JSON file per ADR directory:

```
docs/decisions/.adr-manifest.json
```

For every ADR it stores:

```jsonc
{
  "manifestVersion": 1,
  "records": {
    "0001": {
      "id": 1,
      "path": "docs/decisions/0001-payment-platform.md",
      "title": "Payment platform",
      "status": "accepted",
      "acceptedSha": "4090d8c7…",      // content hash locked in at acceptance
      "lockedAt": "2026-06-18",
      "supersedes": null,
      "supersededBy": null,
      "parent": null,                  // parent/child decomposition links
      "children": ["0002", "0003"],
      "versions": [                    // append-only, addressed by blob SHA
        { "sha": "1f3a…", "status": "proposed",  "commit": "…", "committedAt": "…" },
        { "sha": "4090…", "status": "accepted",  "commit": "…", "committedAt": "…" }
      ]
    }
  }
}
```

Key helpers: `recordVersion` (appends a version, locks `acceptedSha` on
acceptance), `linkSupersedes`, `linkParentChild`, and `verifyManifest` (the
policy engine, shared with CI).

The manifest never stores ADR text — only hashes that point into Git's object
store. It is the **append-only audit trail**.

## 3. Enforcement: CI + branch protection + signed commits

The app *helps* authors follow the rules; the repository *enforces* them. Three
layers:

### a. CI check (`scripts/verify-adr-immutability.mjs`)

Run locally or in CI:

```bash
node scripts/verify-adr-immutability.mjs --base origin/main
# or
npm run verify:immutability
```

It compares the manifest in the working tree against the base branch and fails
the build on any of:

- **Manifest dishonesty** — the recorded head SHA ≠ the file's actual
  `git hash-object`.
- **History rewriting** — a previously recorded version SHA changed or vanished
  (history is append-only).
- **Accepted-ADR mutation** — an `accepted` ADR's content changed while its
  status stayed `accepted`. Editing is only permitted when the ADR is moved to a
  terminal status (`superseded`, `deprecated`, `rejected`) — i.e. you write a new
  ADR that supersedes it.
- **History deletion** — an ADR present in the base manifest is gone.

The GitHub Actions workflow is `.github/workflows/adr-immutability.yml`.

### b. Branch protection (configure on GitHub)

On `Settings → Branches → Branch protection rules` for `main`:

- ✅ **Require a pull request before merging** (with required reviews / CODEOWNERS
  for `docs/**`).
- ✅ **Require status checks to pass** → select **ADR immutability**.
- ✅ **Require signed commits**.
- ✅ **Do not allow force pushes** and **Do not allow deletions** (so the Git
  history backing the hashes can't be rewritten).

Optionally add a `CODEOWNERS` entry:

```
docs/decisions/  @your-org/architects
```

### c. Signed commits

`Require signed commits` ensures each accepted ADR (and each status transition)
is cryptographically attributable. The workflow also re-checks signatures so a
violation shows up directly in the PR checks. Contributors enable signing with:

```bash
git config --global commit.gpgsign true       # GPG
# or SSH signing:
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

---

## Why this satisfies "immutability"

- **Integrity / tamper-evidence** comes from content addressing: the hash *is*
  the identity, and `verifyManifest` re-hashes the tree to detect any drift.
- **Durability of history** comes from Git + "no force-push / no deletion".
- **Authorization** (who may publish a new accepted version, or transition a
  status) comes from required reviews + signed commits.

Content addressing alone proves content *hasn't changed*; the branch-protection
and signing layers are what stop an authorized writer from rewriting history.
Together they deliver immutable, auditable accepted ADRs.
