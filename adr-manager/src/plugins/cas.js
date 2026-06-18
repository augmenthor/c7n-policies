/**
 * Content-Addressable Storage (CAS) helpers.
 *
 * Git already stores every version of every file as an immutable object addressed
 * by the SHA-1 hash of its content (a "blob"). This module lets the ADR-Manager
 * compute that same hash locally so it can:
 *   - address an ADR version by its content hash (content-addressability),
 *   - verify that the content GitHub serves for a given blob SHA has not been
 *     tampered with (integrity / tamper-evidence),
 *   - record the hash of an accepted ADR in the manifest so any later change is
 *     detectable.
 *
 * A Git blob hash is NOT a plain hash of the file. Git prepends a header:
 *
 *     "blob " + <byteLength> + "\0" + <content>
 *
 * and then takes the SHA-1 of the result. This module reproduces that exactly so
 * the values match `git hash-object <file>` and the `sha` returned by the GitHub
 * "blobs"/"trees" APIs.
 */

const encoder = new TextEncoder();

/**
 * Returns the UTF-8 byte length of a string (Git hashes bytes, not characters).
 * @param {string} content
 * @returns {number}
 */
export function utf8ByteLength(content) {
    return encoder.encode(content).length;
}

/**
 * Builds the byte array that Git hashes for a blob: the header followed by the
 * raw content bytes.
 * @param {string} content
 * @returns {Uint8Array}
 */
function gitBlobPayload(content) {
    const contentBytes = encoder.encode(content);
    const header = encoder.encode(`blob ${contentBytes.length}\0`);
    const payload = new Uint8Array(header.length + contentBytes.length);
    payload.set(header, 0);
    payload.set(contentBytes, header.length);
    return payload;
}

/**
 * Converts an ArrayBuffer to a lowercase hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Computes the Git blob SHA-1 of a string. The result is identical to
 * `git hash-object` and to the blob `sha` returned by the GitHub Git Data API.
 *
 * Uses the Web Crypto API, which is available both in browsers and in modern
 * Node.js (>= 16), so the same function works in the app and in tests.
 *
 * @param {string} content - the raw file content (UTF-8)
 * @returns {Promise<string>} the 40-character hex Git blob SHA-1
 */
export async function gitBlobSha(content) {
    const payload = gitBlobPayload(content);
    const digest = await crypto.subtle.digest("SHA-1", payload);
    return bufferToHex(digest);
}

/**
 * Verifies that the given content matches an expected Git blob SHA.
 *
 * @param {string} content - the content as served by GitHub (or local storage)
 * @param {string} expectedSha - the blob SHA recorded in the manifest
 * @returns {Promise<boolean>} true iff the content is intact / un-tampered
 */
export async function verifyContentHash(content, expectedSha) {
    if (!expectedSha) {
        return false;
    }
    const actual = await gitBlobSha(content);
    return actual.toLowerCase() === expectedSha.toLowerCase();
}
