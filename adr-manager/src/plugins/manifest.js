/**
 * ADR immutability manifest.
 *
 * The manifest is a single JSON file (by default `<adrPath>/.adr-manifest.json`)
 * that turns the repository's Git history into an explicit, append-only
 * immutability index for ADRs. For every ADR it records:
 *
 *   - the logical id, path, title and current lifecycle status,
 *   - an append-only list of *versions*, each addressed by its Git blob SHA
 *     (content hash) plus the commit it was introduced in,
 *   - the content hash that was locked in when the ADR became `accepted`,
 *   - cross-links (supersedes / supersededBy, parent / children).
 *
 * Because every version is addressed by a Git blob SHA, the manifest never
 * stores ADR content itself — it points into Git's existing content-addressable
 * object store. Verification (see `verifyManifest`) re-hashes the working tree
 * and checks it against the manifest, which is what the CI workflow enforces on
 * protected branches.
 */

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = ".adr-manifest.json";

/** Lifecycle statuses that release the immutability lock on an accepted ADR. */
export const TERMINAL_STATUSES = ["superseded", "deprecated", "rejected"];

/**
 * Zero-pads a numeric ADR id to the 4-digit key used throughout the manifest
 * and in MADR file names (e.g. 1 -> "0001").
 * @param {number|string} id
 * @returns {string}
 */
export function padId(id) {
    return String(id).padStart(4, "0");
}

/**
 * Returns the full manifest path for a repository's ADR directory.
 * @param {string} adrPath - e.g. "docs/decisions/"
 * @returns {string}
 */
export function manifestPath(adrPath) {
    const base = adrPath.endsWith("/") ? adrPath : adrPath + "/";
    return base + MANIFEST_FILENAME;
}

/**
 * Creates an empty manifest.
 * @returns {object}
 */
export function createEmptyManifest() {
    return {
        manifestVersion: MANIFEST_VERSION,
        updatedAt: null,
        records: {}
    };
}

/**
 * Parses a manifest JSON string, tolerating empty/missing input by returning an
 * empty manifest.
 * @param {string|null|undefined} json
 * @returns {object}
 */
export function parseManifest(json) {
    if (!json || !json.trim()) {
        return createEmptyManifest();
    }
    const data = JSON.parse(json);
    if (!data || typeof data !== "object" || typeof data.records !== "object") {
        throw new Error("Invalid manifest: missing 'records' object.");
    }
    return {
        manifestVersion: data.manifestVersion || MANIFEST_VERSION,
        updatedAt: data.updatedAt || null,
        records: data.records
    };
}

/**
 * Serializes a manifest to a stable, pretty-printed JSON string (sorted keys)
 * so diffs stay readable and deterministic.
 * @param {object} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
    const records = {};
    Object.keys(manifest.records)
        .sort()
        .forEach((key) => {
            records[key] = manifest.records[key];
        });
    return (
        JSON.stringify(
            {
                manifestVersion: manifest.manifestVersion || MANIFEST_VERSION,
                updatedAt: manifest.updatedAt,
                records
            },
            null,
            4
        ) + "\n"
    );
}

/**
 * Returns the record for an id, or undefined.
 * @param {object} manifest
 * @param {number|string} id
 */
export function getRecord(manifest, id) {
    return manifest.records[padId(id)];
}

/**
 * Inserts or updates the metadata of a record (without touching its version
 * history). Returns the record.
 * @param {object} manifest
 * @param {{id:number|string, path:string, title?:string, status?:string}} info
 */
export function upsertRecord(manifest, { id, path, title, status }) {
    const key = padId(id);
    const existing = manifest.records[key];
    const record = existing || {
        id: Number(id),
        path,
        title: title || "",
        status: status || "proposed",
        supersedes: null,
        supersededBy: null,
        parent: null,
        children: [],
        acceptedSha: null,
        lockedAt: null,
        versions: []
    };
    if (path) record.path = path;
    if (title !== undefined) record.title = title;
    if (status) record.status = status;
    manifest.records[key] = record;
    return record;
}

/**
 * Appends a new immutable version to a record's history. Versions are addressed
 * by their Git blob SHA; if the most recent version already has this SHA the
 * call is a no-op (the content did not change).
 *
 * When the version's status is `accepted` and the record is not yet locked, the
 * content hash is locked in as `acceptedSha`.
 *
 * @param {object} manifest
 * @param {number|string} id
 * @param {{sha:string, status:string, commit?:string, committedAt?:string}} version
 * @returns {object} the affected record
 */
export function recordVersion(manifest, id, { sha, status, commit, committedAt }) {
    const record = getRecord(manifest, id);
    if (!record) {
        throw new Error(`Cannot record version for unknown ADR ${padId(id)}.`);
    }
    const last = record.versions[record.versions.length - 1];
    if (!last || last.sha !== sha) {
        record.versions.push({
            sha,
            status: status || record.status,
            commit: commit || null,
            committedAt: committedAt || null
        });
    }
    if (status) {
        record.status = status;
    }
    if (record.status === "accepted" && !record.acceptedSha) {
        record.acceptedSha = sha;
        record.lockedAt = committedAt || new Date().toISOString();
    }
    return record;
}

/**
 * Records that `superseder` supersedes `superseded`, wiring both sides of the
 * link and moving the superseded ADR into the `superseded` status (which
 * releases its immutability lock so the status transition can be committed).
 *
 * @param {object} manifest
 * @param {number|string} supersededId - the older ADR
 * @param {number|string} supersederId - the new ADR replacing it
 */
export function linkSupersedes(manifest, supersededId, supersederId) {
    const older = getRecord(manifest, supersededId);
    const newer = getRecord(manifest, supersederId);
    if (!older || !newer) {
        throw new Error("Both ADRs must exist to link a supersedes relationship.");
    }
    older.supersededBy = padId(supersederId);
    older.status = "superseded";
    newer.supersedes = padId(supersededId);
}

/**
 * Records a parent/child decomposition link (a complex decision broken into
 * simpler ones). Both sides are kept consistent.
 *
 * @param {object} manifest
 * @param {number|string} parentId
 * @param {number|string} childId
 */
export function linkParentChild(manifest, parentId, childId) {
    const parent = getRecord(manifest, parentId);
    const child = getRecord(manifest, childId);
    if (!parent || !child) {
        throw new Error("Both parent and child ADRs must exist to link them.");
    }
    const childKey = padId(childId);
    if (!parent.children.includes(childKey)) {
        parent.children.push(childKey);
        parent.children.sort();
    }
    child.parent = padId(parentId);
}

/**
 * Verifies a proposed manifest + working tree against the previous (base branch)
 * manifest and enforces the immutability policy. This is the heart of the CI
 * check that runs on protected branches.
 *
 * Checks performed:
 *   1. Manifest honesty   - the head version SHA recorded for each ADR matches
 *                           the actual Git blob SHA of the file on disk.
 *   2. Append-only history - every version that existed in the base manifest
 *                           still exists, in the same order (no rewriting the
 *                           audit trail).
 *   3. Accepted immutability - if an ADR was `accepted` in the base manifest and
 *                           its content changed, the change is only allowed when
 *                           the status moves to a terminal status (superseded /
 *                           deprecated / rejected). Silent edits to accepted
 *                           ADRs are rejected.
 *
 * @param {object} options
 * @param {object} options.previousManifest - manifest from the base branch
 * @param {object} options.currentManifest  - manifest in the PR
 * @param {Object.<string,string>} options.currentFileHashes - map of ADR path -> actual Git blob SHA on disk
 * @returns {{ok: boolean, violations: string[]}}
 */
export function verifyManifest({ previousManifest, currentManifest, currentFileHashes }) {
    const violations = [];
    const prev = previousManifest || createEmptyManifest();
    const curr = currentManifest || createEmptyManifest();

    // (1) Manifest honesty: recorded head SHA must equal the file on disk.
    Object.values(curr.records).forEach((record) => {
        const actual = currentFileHashes[record.path];
        const head = record.versions[record.versions.length - 1];
        if (actual === undefined) {
            violations.push(`ADR ${padId(record.id)}: file '${record.path}' is missing from the working tree.`);
            return;
        }
        if (!head) {
            violations.push(`ADR ${padId(record.id)}: manifest has no recorded version.`);
            return;
        }
        if (head.sha !== actual) {
            violations.push(
                `ADR ${padId(record.id)}: manifest head SHA ${head.sha} does not match file content SHA ${actual}. ` +
                    `Re-record the version in the manifest before committing.`
            );
        }
    });

    // (2) + (3): compare against the base manifest record by record.
    Object.values(prev.records).forEach((prevRecord) => {
        const key = padId(prevRecord.id);
        const currRecord = curr.records[key];
        if (!currRecord) {
            violations.push(`ADR ${key}: present in base manifest but removed. ADR history must not be deleted.`);
            return;
        }

        // (2) Append-only history.
        const prevVersions = prevRecord.versions || [];
        const currVersions = currRecord.versions || [];
        prevVersions.forEach((v, idx) => {
            if (!currVersions[idx] || currVersions[idx].sha !== v.sha) {
                violations.push(
                    `ADR ${key}: version history was rewritten at position ${idx} ` +
                        `(expected ${v.sha}, found ${currVersions[idx] ? currVersions[idx].sha : "nothing"}). ` +
                        `History is append-only.`
                );
            }
        });

        // (3) Accepted immutability.
        if (prevRecord.status === "accepted" && prevRecord.acceptedSha) {
            const currentSha = currentFileHashes[currRecord.path];
            const contentChanged = currentSha !== undefined && currentSha !== prevRecord.acceptedSha;
            if (contentChanged && !TERMINAL_STATUSES.includes(currRecord.status)) {
                violations.push(
                    `ADR ${key}: accepted ADR was modified without superseding/deprecating it ` +
                        `(status is still '${currRecord.status}'). Accepted ADRs are immutable — ` +
                        `create a new ADR that supersedes this one instead.`
                );
            }
        }
    });

    return { ok: violations.length === 0, violations };
}
