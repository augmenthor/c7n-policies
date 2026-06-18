import {
    createEmptyManifest,
    parseManifest,
    serializeManifest,
    upsertRecord,
    recordVersion,
    linkSupersedes,
    linkParentChild,
    verifyManifest,
    manifestPath,
    padId,
    getRecord
} from "../src/plugins/manifest.js";

function manifestWithAcceptedAdr(path = "docs/decisions/0001-foo.md", sha = "a".repeat(40)) {
    const m = createEmptyManifest();
    upsertRecord(m, { id: 1, path, title: "Foo", status: "proposed" });
    recordVersion(m, 1, { sha: "1".repeat(40), status: "proposed", commit: "c1", committedAt: "2026-01-01" });
    recordVersion(m, 1, { sha, status: "accepted", commit: "c2", committedAt: "2026-01-02" });
    return m;
}

test("padId zero-pads to four digits", () => {
    expect(padId(1)).toBe("0001");
    expect(padId("42")).toBe("0042");
});

test("manifestPath appends the manifest filename", () => {
    expect(manifestPath("docs/decisions/")).toBe("docs/decisions/.adr-manifest.json");
    expect(manifestPath("docs/adr")).toBe("docs/adr/.adr-manifest.json");
});

test("recordVersion locks acceptedSha when status becomes accepted", () => {
    const acceptedSha = "a".repeat(40);
    const m = manifestWithAcceptedAdr("docs/decisions/0001-foo.md", acceptedSha);
    const record = getRecord(m, 1);
    expect(record.status).toBe("accepted");
    expect(record.acceptedSha).toBe(acceptedSha);
    expect(record.versions).toHaveLength(2);
});

test("recordVersion is a no-op when the content hash is unchanged", () => {
    const m = manifestWithAcceptedAdr();
    recordVersion(m, 1, { sha: "a".repeat(40), status: "accepted" });
    expect(getRecord(m, 1).versions).toHaveLength(2);
});

test("serialize then parse round-trips", () => {
    const m = manifestWithAcceptedAdr();
    const parsed = parseManifest(serializeManifest(m));
    expect(parsed.records["0001"].acceptedSha).toBe("a".repeat(40));
});

test("linkSupersedes wires both sides and supersedes the old ADR", () => {
    const m = manifestWithAcceptedAdr();
    upsertRecord(m, { id: 2, path: "docs/decisions/0002-bar.md", title: "Bar", status: "accepted" });
    linkSupersedes(m, 1, 2);
    expect(getRecord(m, 1).supersededBy).toBe("0002");
    expect(getRecord(m, 1).status).toBe("superseded");
    expect(getRecord(m, 2).supersedes).toBe("0001");
});

test("linkParentChild wires parent and child symmetrically", () => {
    const m = createEmptyManifest();
    upsertRecord(m, { id: 1, path: "docs/decisions/0001-parent.md", title: "Parent" });
    upsertRecord(m, { id: 2, path: "docs/decisions/0002-child.md", title: "Child" });
    linkParentChild(m, 1, 2);
    expect(getRecord(m, 1).children).toContain("0002");
    expect(getRecord(m, 2).parent).toBe("0001");
});

describe("verifyManifest", () => {
    test("passes when nothing changed", () => {
        const acceptedSha = "a".repeat(40);
        const prev = manifestWithAcceptedAdr("docs/decisions/0001-foo.md", acceptedSha);
        const curr = parseManifest(serializeManifest(prev));
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: { "docs/decisions/0001-foo.md": acceptedSha }
        });
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
    });

    test("rejects a silent edit to an accepted ADR", () => {
        const acceptedSha = "a".repeat(40);
        const prev = manifestWithAcceptedAdr("docs/decisions/0001-foo.md", acceptedSha);
        // Author edited the file but left status "accepted" and updated the head version.
        const curr = parseManifest(serializeManifest(prev));
        const newSha = "b".repeat(40);
        recordVersion(curr, 1, { sha: newSha, status: "accepted", commit: "c3" });
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: { "docs/decisions/0001-foo.md": newSha }
        });
        expect(result.ok).toBe(false);
        expect(result.violations.join(" ")).toMatch(/immutable/i);
    });

    test("allows editing an accepted ADR when it is being superseded", () => {
        const acceptedSha = "a".repeat(40);
        const prev = manifestWithAcceptedAdr("docs/decisions/0001-foo.md", acceptedSha);
        const curr = parseManifest(serializeManifest(prev));
        const newSha = "b".repeat(40);
        // Status transitions to superseded (the one allowed change), new head recorded.
        recordVersion(curr, 1, { sha: newSha, status: "superseded", commit: "c3" });
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: { "docs/decisions/0001-foo.md": newSha }
        });
        expect(result.ok).toBe(true);
    });

    test("rejects rewriting the append-only history", () => {
        const prev = manifestWithAcceptedAdr();
        const curr = parseManifest(serializeManifest(prev));
        // Tamper: change the first recorded version's SHA.
        curr.records["0001"].versions[0].sha = "9".repeat(40);
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: { "docs/decisions/0001-foo.md": "a".repeat(40) }
        });
        expect(result.ok).toBe(false);
        expect(result.violations.join(" ")).toMatch(/append-only/i);
    });

    test("rejects a manifest whose head SHA does not match the file on disk", () => {
        const prev = manifestWithAcceptedAdr();
        const curr = parseManifest(serializeManifest(prev));
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: { "docs/decisions/0001-foo.md": "f".repeat(40) } // disk differs from manifest head
        });
        expect(result.ok).toBe(false);
        expect(result.violations.join(" ")).toMatch(/does not match/i);
    });

    test("rejects deletion of an ADR from history", () => {
        const prev = manifestWithAcceptedAdr();
        const curr = createEmptyManifest();
        const result = verifyManifest({
            previousManifest: prev,
            currentManifest: curr,
            currentFileHashes: {}
        });
        expect(result.ok).toBe(false);
        expect(result.violations.join(" ")).toMatch(/removed/i);
    });
});
