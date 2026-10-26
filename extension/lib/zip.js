// Minimal ZIP writer (no dependencies). Uses CompressionStream('deflate-raw')
// for method 8 and falls back to stored entries when compression is unavailable
// or unhelpful. Loadable from both the service worker and the offscreen page.
globalThis.BuckeyeZip = (function () {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xffff, date: day & 0xffff };
  }

  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ZIP paths are always forward-slashed and relative.
  function normalizePath(path) {
    return String(path)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter((segment) => segment && segment !== '.' && segment !== '..')
      .join('/');
  }

  /**
   * @param {Array<{path: string, text?: string, bytes?: Uint8Array}>} entries
   * @param {{compress?: boolean, onProgress?: (done: number, total: number) => void}} options
   * @returns {Promise<Blob>}
   */
  async function create(entries, options = {}) {
    const { compress = true, onProgress } = options;
    const encoder = new TextEncoder();
    const stamp = dosDateTime(new Date());
    const canCompress = compress && typeof CompressionStream !== 'undefined';

    const parts = [];
    const central = [];
    const seen = new Set();
    let offset = 0;
    let index = 0;

    for (const entry of entries) {
      let path = normalizePath(entry.path);
      if (!path) continue;
      while (seen.has(path.toLowerCase())) {
        path = path.replace(/(\.[^./]*)?$/, (ext) => `-${++index}${ext || ''}`);
      }
      seen.add(path.toLowerCase());

      const nameBytes = encoder.encode(path);
      const data = entry.bytes instanceof Uint8Array ? entry.bytes : encoder.encode(entry.text ?? '');
      const crc = crc32(data);

      let method = 0;
      let payload = data;
      if (canCompress && data.length > 64) {
        try {
          const deflated = await deflateRaw(data);
          if (deflated.length < data.length) {
            method = 8;
            payload = deflated;
          }
        } catch {
          /* keep the stored copy */
        }
      }

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filenames
      lv.setUint16(8, method, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const directory = new Uint8Array(46 + nameBytes.length);
      const dv = new DataView(directory.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 0x031e, true); // made by: unix, zip 3.0
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, method, true);
      dv.setUint16(12, stamp.time, true);
      dv.setUint16(14, stamp.date, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, payload.length, true);
      dv.setUint32(24, data.length, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, (0o100644 * 65536) >>> 0, true);
      dv.setUint32(42, offset, true);
      directory.set(nameBytes, 46);

      parts.push(local, payload);
      central.push(directory);
      offset += local.length + payload.length;

      if (onProgress) onProgress(central.length, entries.length);
    }

    const centralSize = central.reduce((total, item) => total + item.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  return { create, crc32, normalizePath };
})();
