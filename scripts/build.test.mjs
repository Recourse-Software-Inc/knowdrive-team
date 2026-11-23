// Run: node --test scripts/build.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { qrEncode, qrSvgPath, qrPng, formatInfo, rsRemainder, dataCodewords } from './qr.mjs'
import { loadStaff, outputs, vcard, cardPage, meetPage, urls, DOMAIN } from './build.mjs'

// --- QR encoder: vectors from ISO/IEC 18004 ----------------------------------
test('qr: format information matches the spec example (level M, mask 5)', () => {
  assert.equal(formatInfo('M', 5).toString(2).padStart(15, '0'), '100000011001110')
})

test('qr: Reed-Solomon matches the spec example ("01234567", version 1-M)', () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
  assert.deepEqual(rsRemainder(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55])
})

test('qr: data capacity per version matches the spec table', () => {
  assert.deepEqual([1, 3, 4, 7, 10].map((v) => dataCodewords(v, 'M')), [16, 44, 64, 124, 216])
  assert.deepEqual([1, 5, 10].map((v) => dataCodewords(v, 'H')), [9, 46, 122])
})

test('qr: picks the smallest version and refuses what does not fit', () => {
  assert.equal(qrEncode('https://team.knowdrive.ai/joelauge/meet').version, 3)
  assert.equal(qrEncode('x'.repeat(213)).version, 10)
  assert.throws(() => qrEncode('x'.repeat(214)), /do not fit/)
})

test('qr: structural invariants (finders, timing, dark module)', () => {
  const { modules: m, size } = qrEncode('https://team.knowdrive.ai/joelauge/meet')
  assert.equal(size, 29)
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(m[oy][ox + i] && m[oy + 6][ox + i] && m[oy + i][ox] && m[oy + i][ox + 6], 'finder ring')
    }
    assert.ok(m[oy + 3][ox + 3], 'finder centre')
    assert.ok(!m[oy + 1][ox + 1], 'finder gap')
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, 'horizontal timing')
    assert.equal(m[i][6], i % 2 === 0, 'vertical timing')
  }
  assert.ok(m[size - 8][8], 'dark module')
})

// The symbol for Joel's booking URL, pinned after it was read back with an
// independent decoder (Apple Vision) on 2026-11-23. If this hash moves, the
// encoder's output changed: scan a code again before accepting the new value.
test('qr: the pinned symbol is unchanged', () => {
  const qr = qrEncode('https://team.knowdrive.ai/joelauge/meet', { ecl: 'M' })
  assert.equal(createHash('sha256').update(qrSvgPath(qr, 4)).digest('hex'), '25ebcdce9de30a77e62f3279ff7532aaa5f2fb316ba8cea5f0207e76e76ac9ad')
})

test('qr: png writer emits a valid header and square dimensions', () => {
  const png = qrPng(qrEncode('A'), { scale: 4 })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), (21 + 8) * 4)
  assert.equal(png.readUInt32BE(20), (21 + 8) * 4)
})

// --- Site --------------------------------------------------------------------
const staff = loadStaff()

test('site: GitHub Pages files and one folder per person', () => {
  const out = outputs(staff)
  assert.equal(out.CNAME, `${DOMAIN}\n`)
  assert.ok('.nojekyll' in out)
  for (const p of staff) {
    for (const file of ['index.html', 'meet/index.html', 'portrait.jpg', `${p.slug}.vcf`, 'meet-qr.svg', 'meet-qr.png']) {
      assert.ok(`${p.slug}/${file}` in out, `${p.slug}/${file}`)
    }
  }
})

test('site: every local link and asset a page references is in the build', () => {
  const out = outputs(staff)
  for (const [file, content] of Object.entries(out)) {
    if (!file.endsWith('.html')) continue
    const dir = file.split('/').slice(0, -1)
    for (const [, ref] of String(content).matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|tel:)/.test(ref)) continue
      const parts = [...dir]
      for (const seg of ref.split('/')) {
        if (seg === '..') parts.pop()
        else if (seg && seg !== '.') parts.push(seg)
      }
      const target = parts.join('/')
      assert.ok(target === '' || target in out || `${target}/index.html` in out, `${file} -> ${ref}`)
    }
  }
})

test('site: the QR, the card button and the vCard all lead to the booking page', () => {
  for (const p of staff) {
    const card = cardPage(p)
    assert.ok(card.includes('href="meet/"'))
    assert.ok(card.includes(qrSvgPath(qrEncode(`https://${DOMAIN}/${p.slug}/meet`), 4)))
    assert.equal(urls(p).meet, `https://${DOMAIN}/${p.slug}/meet`)
    const vcf = vcard(p)
    assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/)
    assert.ok(vcf.includes(`EMAIL;TYPE=INTERNET,WORK:${p.email}\r\n`))
    assert.ok(vcf.includes(`NOTE:Book a meeting: https://${DOMAIN}/${p.slug}/meet\r\n`))
    assert.ok(vcf.endsWith('END:VCARD\r\n'))
    for (const line of vcf.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'vCard line folding')
    // Unfolding the photo gives back the portrait, byte for byte.
    const photo = vcf.replace(/\r\n /g, '').match(/PHOTO;ENCODING=b;TYPE=JPEG:([^\r]+)/)[1]
    assert.ok(Buffer.from(photo, 'base64').equals(p.portraitBytes))
  }
})

test('site: the booking page embeds the schedule and links out as a fallback', () => {
  for (const p of staff) {
    const html = meetPage(p)
    assert.ok(html.includes(`<iframe src="${p.booking.url}?gv=true"`))
    assert.ok(html.includes(`<a href="${p.booking.url}" target="_blank" rel="noopener">`))
    assert.ok(html.includes('<a class="kds-back" href="../">'))
  }
})
