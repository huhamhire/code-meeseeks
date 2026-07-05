/**
 * Sniff common image formats by file-header magic numbers; falls back to octet-stream when it
 * can't be sniffed (the browser may still decode PNG).
 *
 * Used to restore the content-type when reading back a Bitbucket avatar after it was persisted
 * locally — only raw bytes are stored on write, and reading back still needs to build a data URL,
 * so a missing content-type would keep <img src> from rendering. Bitbucket can in practice only
 * return one of PNG / JPEG / GIF / WebP / SVG, but the full set is kept as defensive sniffing.
 */
export function sniffImageContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // SVG / XML starts with '<'; a blame avatar shouldn't be SVG but this is a fallback
  if (bytes.length >= 1 && bytes[0] === 0x3c) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}
