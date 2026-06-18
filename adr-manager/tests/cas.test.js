import { gitBlobSha, verifyContentHash, utf8ByteLength } from "../src/plugins/cas.js";

// The expected values below are the canonical Git blob SHAs, identical to what
// `git hash-object` produces. They are well-known constants for these inputs.

test("git blob SHA of empty content matches git hash-object", async () => {
    await expect(gitBlobSha("")).resolves.toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("git blob SHA of 'hello\\n' matches git hash-object", async () => {
    await expect(gitBlobSha("hello\n")).resolves.toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});

test("utf8ByteLength counts bytes, not characters", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2); // 2 bytes in UTF-8
});

test("different content produces a different hash", async () => {
    const a = await gitBlobSha("# ADR 1\nstatus: accepted\n");
    const b = await gitBlobSha("# ADR 1\nstatus: superseded\n");
    expect(a).not.toBe(b);
});

test("verifyContentHash detects intact and tampered content", async () => {
    const content = "# ADR 1\nstatus: accepted\n";
    const sha = await gitBlobSha(content);
    await expect(verifyContentHash(content, sha)).resolves.toBe(true);
    await expect(verifyContentHash(content + " tampered", sha)).resolves.toBe(false);
    await expect(verifyContentHash(content, "")).resolves.toBe(false);
});
