#!/usr/bin/env node
/**
 * CI enforcement for ADR immutability.
 *
 * This script is the "protected branch" half of the immutability story. It is
 * meant to run as a required status check on pull requests so that, even though
 * the ADR-Manager web app can write to a repository, no one can silently rewrite
 * an accepted ADR or tamper with the append-only history recorded in the
 * manifest.
 *
 * What it does:
 *   1. Finds every `.adr-manifest.json` in the working tree.
 *   2. Loads the same manifest from the base ref (default: origin/main) to get
 *      the "previous" state.
 *   3. Computes the canonical Git blob SHA of each referenced ADR file using
 *      `git hash-object` (the authoritative value — no re-implementation).
 *   4. Runs the shared policy in src/plugins/manifest.js (verifyManifest).
 *
 * Exit code 0 = compliant, 1 = violations found (fails the build).
 *
 * Usage:
 *   node scripts/verify-adr-immutability.mjs [--base <ref>] [manifest ...]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseManifest, createEmptyManifest, verifyManifest } from "../src/plugins/manifest.js";

function git(args, opts = {}) {
    return execFileSync("git", args, { encoding: "utf-8", ...opts }).trim();
}

/** Returns the Git blob SHA of a file in the working tree, or undefined if absent. */
function workingTreeBlobSha(path) {
    if (!existsSync(path)) {
        return undefined;
    }
    return git(["hash-object", path]);
}

/** Returns the content of a path at a ref, or null if it does not exist there. */
function showAtRef(ref, path) {
    try {
        return git(["show", `${ref}:${path}`]);
    } catch {
        return null;
    }
}

function parseArgs(argv) {
    const args = { base: process.env.BASE_REF || "origin/main", manifests: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--base") {
            args.base = argv[++i];
        } else {
            args.manifests.push(argv[i]);
        }
    }
    return args;
}

function findManifests() {
    // All tracked .adr-manifest.json files.
    const out = git(["ls-files", "*.adr-manifest.json"]);
    return out ? out.split("\n").filter(Boolean) : [];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const manifests = args.manifests.length ? args.manifests : findManifests();

    if (manifests.length === 0) {
        console.log("No .adr-manifest.json found — nothing to verify.");
        return;
    }

    let totalViolations = 0;

    for (const manifestFile of manifests) {
        const dir = dirname(manifestFile);
        const currentManifest = parseManifest(readFileSync(manifestFile, "utf-8"));

        const prevRaw = showAtRef(args.base, manifestFile);
        const previousManifest = prevRaw ? parseManifest(prevRaw) : createEmptyManifest();

        // Build the actual content hashes for every path referenced by either
        // the current or the previous manifest.
        const paths = new Set();
        Object.values(currentManifest.records).forEach((r) => paths.add(r.path));
        Object.values(previousManifest.records).forEach((r) => paths.add(r.path));

        const currentFileHashes = {};
        for (const p of paths) {
            const sha = workingTreeBlobSha(p);
            if (sha !== undefined) {
                currentFileHashes[p] = sha;
            }
        }

        const { ok, violations } = verifyManifest({ previousManifest, currentManifest, currentFileHashes });

        if (ok) {
            console.log(`✓ ${manifestFile}: ${Object.keys(currentManifest.records).length} ADR(s) compliant.`);
        } else {
            console.error(`✗ ${manifestFile}: ${violations.length} violation(s):`);
            violations.forEach((v) => console.error(`   - ${v}`));
            totalViolations += violations.length;
        }
    }

    if (totalViolations > 0) {
        console.error(`\nImmutability check FAILED with ${totalViolations} violation(s).`);
        process.exit(1);
    }
    console.log("\nImmutability check passed.");
}

main();
