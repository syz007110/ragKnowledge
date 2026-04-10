import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

function digestToHex(digest) {
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 hex digest of a File/Blob.
 * 优先 Web Crypto（快）；在「非安全上下文」下（如 http://192.168.x.x 打开页面）subtle 不可用，回退到纯 JS。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function sha256HexFromBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', buffer);
      return digestToHex(digest);
    } catch {
      // 极少数环境 digest 抛错时走回退
    }
  }
  return bytesToHex(sha256(new Uint8Array(buffer)));
}
