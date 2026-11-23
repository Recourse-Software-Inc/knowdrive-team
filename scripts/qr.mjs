// Dependency-free QR Code encoder (Model 2, byte mode, versions 1-10) for the
// team contact cards (scripts/build.mjs). It exists so each card can carry its
// QR as inline SVG with no dependencies and no call to an outside QR service.
//
// Versions 1-10 hold up to 213 bytes at level M, far more than a
// https://team.knowdrive.ai/<slug>/meet URL needs. Longer input throws.
//
// Correctness is pinned by scripts/build.test.mjs: the format-info and
// Reed-Solomon vectors from ISO/IEC 18004, plus a snapshot of a symbol that was
// read back with an independent decoder (Apple Vision) when it was pinned.
import { deflateSync } from 'node:zlib'

const ECC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
}
const NUM_BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
}
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }
const MAX_VERSION = 10

function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

export function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver]
}

// --- Reed-Solomon over GF(2^8), primitive polynomial 0x11D -------------------
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < degree) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 2)
  }
  return out
}

export function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree)
  const out = new Array(degree).fill(0)
  for (const b of data) {
    const factor = b ^ out.shift()
    out.push(0)
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(divisor[i], factor)
  }
  return out
}

// --- Codeword stream ---------------------------------------------------------
function encodeData(bytes, ver, ecl) {
  const capacity = dataCodewords(ver, ecl)
  const bits = []
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4) // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, capacity * 8 - bits.length)) // terminator
  while (bits.length % 8) bits.push(0)
  const out = []
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad)
  return out
}

function interleave(data, ver, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][ver]
  const eccLen = ECC_PER_BLOCK[ecl][ver]
  const raw = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const blocks = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, eccLen)
    if (i < numShort) dat.push(0) // placeholder, skipped below
    blocks.push(dat.concat(ecc))
  }
  const out = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i])
    })
  }
  return out
}

// --- Symbol ------------------------------------------------------------------
function alignmentPositions(ver) {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const out = [6]
  for (let pos = ver * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

export function formatInfo(ecl, mask) {
  const data = (FORMAT_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function buildSymbol(codewords, ver, ecl, mask) {
  const size = ver * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true }

  // Timing patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  // Finder patterns with their separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  // Alignment patterns (skipping the three finder corners).
  const align = alignmentPositions(ver)
  const last = align.length - 1
  align.forEach((cy, i) => align.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }))
  // Format info (both copies) + the always-dark module.
  const drawFormat = (bits) => {
    const bit = (i) => ((bits >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0) // reserve the area before data placement
  // Version info (versions 7+).
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3), b = Math.floor(i / 3)
      set(a, b, dark); set(b, a, dark)
    }
  }
  // Data + error-correction bits, zigzag from the bottom-right corner.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (fn[y][x]) continue
        const dark = i < codewords.length * 8 && ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1
        mod[y][x] = dark !== MASKS[mask](x, y)
        i++
      }
    }
  }
  drawFormat(formatInfo(ecl, mask))
  return mod
}

function penalty(mod) {
  const size = mod.length
  let score = 0
  const lines = []
  for (let y = 0; y < size; y++) lines.push(mod[y])
  for (let x = 0; x < size; x++) lines.push(mod.map((row) => row[x]))
  for (const line of lines) {
    // N1: runs of five or more.
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i + 1 === size || line[i + 1] !== line[i]) {
        if (run >= 5) score += run - 2
        run = 0
      }
    }
    // N3: finder-like 1:1:3:1:1 with four light modules on either side.
    const s = line.map((d) => (d ? '1' : '0')).join('')
    for (const pat of ['10111010000', '00001011101']) {
      for (let at = s.indexOf(pat); at !== -1; at = s.indexOf(pat, at + 1)) score += 40
    }
  }
  // N2: 2x2 blocks of one colour.
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mod[y][x]) dark++
      if (x + 1 < size && y + 1 < size && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) score += 3
    }
  }
  // N4: balance of dark and light.
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}

/**
 * Encode `text` (UTF-8, byte mode) as a QR symbol.
 * @returns {{version:number, ecl:string, mask:number, size:number, modules:boolean[][]}}
 *   modules[y][x] is true for a dark module; no quiet zone included.
 */
export function qrEncode(text, { ecl = 'M', mask = null } = {}) {
  if (!(ecl in FORMAT_BITS)) throw new Error(`qr: unknown error-correction level ${ecl}`)
  const bytes = [...Buffer.from(text, 'utf8')]
  let ver = 1
  // 4 mode bits + the length field + data must fit the version's data capacity.
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, ecl) * 8) ver++
  if (ver > MAX_VERSION) throw new Error(`qr: ${bytes.length} bytes do not fit version ${MAX_VERSION} at level ${ecl}`)
  const codewords = interleave(encodeData(bytes, ver, ecl), ver, ecl)
  let best = null
  for (const m of mask === null ? MASKS.keys() : [mask]) {
    const modules = buildSymbol(codewords, ver, ecl, m)
    const score = penalty(modules)
    if (!best || score < best.score) best = { mask: m, modules, score }
  }
  return { version: ver, ecl, mask: best.mask, size: ver * 4 + 17, modules: best.modules }
}

/** One <path> of merged horizontal runs, in module units, quiet zone included. */
export function qrSvgPath(qr, quiet = 4) {
  let d = ''
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let len = 1
      while (x + len < row.length && row[x + len]) len++
      d += `M${x + quiet} ${y + quiet}h${len}v1h-${len}z`
      x += len
    }
  })
  return d
}

export function qrSvg(qr, { quiet = 4, dark = '#15151f', light = '#ffffff', title = '' } = {}) {
  const dim = qr.size + quiet * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"` +
    (title ? ` role="img" aria-label="${title}"` : '') + `>` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/><path fill="${dark}" d="${qrSvgPath(qr, quiet)}"/></svg>`
}

// --- PNG (for print: business cards, slides) ---------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 8-bit greyscale PNG, `scale` pixels per module, quiet zone included. */
export function qrPng(qr, { scale = 16, quiet = 4 } = {}) {
  const dim = (qr.size + quiet * 2) * scale
  const raw = Buffer.alloc((dim + 1) * dim, 0xff)
  for (let py = 0; py < dim; py++) {
    raw[py * (dim + 1)] = 0 // filter: none
    const y = Math.floor(py / scale) - quiet
    if (y < 0 || y >= qr.size) continue
    for (let px = 0; px < dim; px++) {
      const x = Math.floor(px / scale) - quiet
      if (x >= 0 && x < qr.size && qr.modules[y][x]) raw[py * (dim + 1) + 1 + px] = 0x15
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
