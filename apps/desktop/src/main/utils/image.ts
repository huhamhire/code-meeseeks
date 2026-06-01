/**
 * 按文件头魔数嗅探常见图片格式；嗅不出退到 octet-stream（浏览器仍可能解码 PNG）。
 *
 * 用于 BBS 头像本地落盘后回读时还原 content-type —— 落盘时只存裸字节，回读后
 * 还要拼 data URL，content-type 缺失会导致 <img src> 不渲染。BBS 实际只可能
 * 返回 PNG / JPEG / GIF / WebP / SVG 其中之一，但作为防御性嗅探留全。
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
  // SVG / XML 以 '<' 起；blame avatar 应该不会出 SVG 但兜底
  if (bytes.length >= 1 && bytes[0] === 0x3c) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}
