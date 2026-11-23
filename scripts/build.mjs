#!/usr/bin/env node
// Build the team.knowdrive.ai contact cards into docs/ (GitHub Pages serves
// main:/docs). For each staff/<slug>.json:
//
//   /<slug>/        the card: portrait, role, contact rows, "Save contact"
//                   (a vCard file), and a QR code that opens the booking page
//   /<slug>/meet/   the booking page: the person's Google Calendar appointment
//                   schedule, embedded. This is the URL the QR encodes, so a
//                   printed code keeps working if the schedule is replaced.
//
// The output is plain static files with no build-time dependencies: the QR is
// drawn by scripts/qr.mjs and inlined as SVG.
//
// Usage: node scripts/build.mjs           # rewrite docs/
//        node scripts/build.mjs --check   # exit 1 if docs/ is stale
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { qrEncode, qrSvgPath, qrSvg, qrPng } from './qr.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const DOMAIN = 'team.knowdrive.ai'
export const ORIGIN = `https://${DOMAIN}`
const PRODUCT = { name: 'KnowDrive', url: 'https://knowdrive.ai/', tagline: 'Shared memory and cited answers for AI agents' }
const FONTS = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap'
const QR_QUIET = 4

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const digits = (phone) => phone.replace(/[\s().-]/g, '')
const plainTitle = (p) => p.title.replace(/\s*·\s*/g, ', ')

// --- Source ------------------------------------------------------------------
export function loadStaff(dir = join(ROOT, 'staff')) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => {
    const p = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    const fail = (msg) => { throw new Error(`staff/${file}: ${msg}`) }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug ?? '')) fail('slug must be lowercase letters, digits and single hyphens')
    if (file !== `${p.slug}.json`) fail(`slug "${p.slug}" must match the filename`)
    if (['assets', 'docs', 'favicon'].includes(p.slug)) fail(`slug "${p.slug}" is reserved`)
    for (const key of ['name', 'givenName', 'familyName', 'title', 'org', 'email', 'portrait']) {
      if (!p[key]) fail(`"${key}" is required`)
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) fail('"email" is not an address')
    if (p.phone && !/^\+[1-9]\d{6,14}$/.test(digits(p.phone))) fail('"phone" must be international format, e.g. "+1 416 555 0100"')
    if (p.linkedin && !/^https:\/\/[^\s"<>]+$/.test(p.linkedin)) fail('"linkedin" must be an https URL')
    if (!/^https:\/\/[^\s"<>]+$/.test(p.booking?.url ?? '')) fail('"booking.url" must be an https URL')
    return { ...p, portraitBytes: readFileSync(join(dir, p.portrait)) }
  })
}

/** Public URLs. GitHub Pages redirects the slash-less form to the directory. */
export const urls = (p) => ({ card: `${ORIGIN}/${p.slug}`, meet: `${ORIGIN}/${p.slug}/meet` })

// --- vCard -------------------------------------------------------------------
const vEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
// RFC 2426 line folding: 75 octets, continuation lines start with one space.
const fold = (line) => {
  const out = []
  let rest = Buffer.from(line, 'utf8')
  for (let limit = 75; rest.length > limit; limit = 74) {
    let cut = limit
    while ((rest[cut] & 0xc0) === 0x80) cut-- // never split a UTF-8 sequence
    out.push(rest.subarray(0, cut).toString('utf8'))
    rest = rest.subarray(cut)
  }
  out.push(rest.toString('utf8'))
  return out.join('\r\n ')
}
export function vcard(p) {
  const { card, meet } = urls(p)
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vEsc(p.familyName)};${vEsc(p.givenName)};;;`,
    `FN:${vEsc(p.name)}`,
    `ORG:${vEsc(p.legalOrg ? `${p.org} (${p.legalOrg})` : p.org)}`,
    `TITLE:${vEsc(plainTitle(p))}`,
    `EMAIL;TYPE=INTERNET,WORK:${p.email}`,
    ...(p.phone ? [`TEL;TYPE=CELL,VOICE:${digits(p.phone)}`] : []),
    `URL:${card}`,
    ...(p.linkedin ? [`item1.URL:${p.linkedin}`, 'item1.X-ABLabel:LinkedIn'] : []),
    `NOTE:${vEsc(`Book a meeting: ${meet}`)}`,
    `PHOTO;ENCODING=b;TYPE=JPEG:${p.portraitBytes.toString('base64')}`,
    'END:VCARD',
  ].map(fold).join('\r\n') + '\r\n'
}

// --- Markup ------------------------------------------------------------------
const ICON = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  save: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 8 8 5.5L20 8"/>',
  phone: '<path d="M6.6 3h2.2a1 1 0 0 1 1 .8l.7 3.3a1 1 0 0 1-.3.9L8.6 9.6a14 14 0 0 0 5.8 5.8l1.6-1.6a1 1 0 0 1 .9-.3l3.3.7a1 1 0 0 1 .8 1v2.2A2.6 2.6 0 0 1 18.4 20 15.4 15.4 0 0 1 4 5.6 2.6 2.6 0 0 1 6.6 3z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
}
const icon = (name, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`
const LINKEDIN_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M5 3.5a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM3.1 9.6h3.8v11H3.1zM9.3 9.6h3.65v1.5H13c.5-.95 1.75-1.8 3.6-1.8 3.85 0 4.4 2.4 4.4 5.6v5.7h-3.8v-5.05c0-1.2 0-2.75-1.7-2.75s-1.95 1.3-1.95 2.65v5.15H9.3z"/></svg>'

// `up` is the relative path from the page to the site root, so the same files
// work on the custom domain, on the github.io project URL and from a local folder.
function page({ title, description, canonical, image, up, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#fbfaff">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="${esc(PRODUCT.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/svg+xml" href="${up}favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${up}assets/card.css">
</head>
<body>
${body}
</body>
</html>
`
}

const foot = `<p class="kds-foot"><a href="${PRODUCT.url}">${PRODUCT.name}</a> · ${PRODUCT.tagline}</p>`

function qrMarkup(p) {
  const qr = qrEncode(urls(p).meet, { ecl: 'M' })
  const dim = qr.size + QR_QUIET * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${esc(`QR code: book a meeting with ${p.name}`)}"><rect width="${dim}" height="${dim}" fill="#fff"/><path fill="#15151f" d="${qrSvgPath(qr, QR_QUIET)}"/></svg>`
}

export function cardPage(p) {
  const first = esc(p.givenName)
  const qr = qrMarkup(p)
  const ext = ' target="_blank" rel="noopener"'
  const row = (href, ico, label, value, attrs = '') =>
    `<li><a class="kds-row" href="${esc(href)}"${attrs}><span class="kds-ico">${ico}</span><span class="kds-txt"><small>${label}</small><b>${esc(value)}</b></span><span class="kds-chev">${icon('chevron', 18)}</span></a></li>`
  const rows = [
    row(`mailto:${p.email}`, icon('mail'), 'Email', p.email),
    ...(p.phone ? [row(`tel:${digits(p.phone)}`, icon('phone'), 'Phone', p.phone)] : []),
    ...(p.linkedin ? [row(p.linkedin, LINKEDIN_ICON, 'LinkedIn', p.linkedin.replace(/^https:\/\/(www\.)?linkedin\.com\//, '').replace(/\/$/, ''), ext)] : []),
    row(PRODUCT.url, icon('globe'), 'Website', new URL(PRODUCT.url).host),
  ]
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: p.name,
    jobTitle: plainTitle(p),
    worksFor: { '@type': 'Organization', name: p.org, url: PRODUCT.url },
    url: `${urls(p).card}/`,
    image: `${urls(p).card}/portrait.jpg`,
    ...(p.linkedin ? { sameAs: p.linkedin } : {}),
  }
  const vcfName = `${p.name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, '-')}.vcf`
  const body = [
    `<main class="kds">`,
    `<article class="kds-card">`,
    `<div class="kds-band"><a class="kds-brand" href="${PRODUCT.url}" aria-label="${PRODUCT.name} home"><img src="../assets/kd-mark-white.svg" alt="" width="29" height="18">${PRODUCT.name}</a></div>`,
    `<div class="kds-body">`,
    `<img class="kds-photo" src="portrait.jpg" alt="Portrait of ${esc(p.name)}" width="104" height="104">`,
    `<h1 class="kds-name">${esc(p.name)}</h1>`,
    `<p class="kds-role">${esc(p.title)}</p>`,
    `<p class="kds-org">${esc(p.legalOrg ? `${p.org} · ${p.legalOrg}` : p.org)}</p>`,
    ...(p.bio ? [`<p class="kds-bio">${esc(p.bio)}</p>`] : []),
    `<div class="kds-actions">`,
    `<a class="kds-btn kds-btn-primary" href="meet/">${icon('calendar')}Book a meeting</a>`,
    `<a class="kds-btn" href="${esc(p.slug)}.vcf" download="${esc(vcfName)}">${icon('save')}Save contact</a>`,
    `</div>`,
    `<ul class="kds-list">`,
    ...rows,
    `</ul>`,
    `<section class="kds-qr" aria-labelledby="kds-qr-h">`,
    `<h2 id="kds-qr-h">Scan to book a meeting</h2>`,
    `<button type="button" class="kds-qr-tile" id="kds-qr-open" aria-label="Enlarge the QR code">${qr}</button>`,
    `<p>Point a phone camera at the code to pick a time on ${first}'s calendar.</p>`,
    `</section>`,
    `</div>`,
    `</article>`,
    foot,
    `<dialog class="kds-dialog" id="kds-qr-dialog" aria-label="QR code: book a meeting with ${esc(p.name)}">`,
    qr,
    `<b>Book a meeting with ${first}</b><span>Scan with a phone camera</span>`,
    `<button type="button">Close</button>`,
    `</dialog>`,
    `</main>`,
    // Enlarge-on-tap is an enhancement: without JavaScript the code is still on the card.
    `<script>(function(){var d=document.getElementById('kds-qr-dialog'),o=document.getElementById('kds-qr-open');if(!d||!o||!d.showModal)return;o.addEventListener('click',function(){d.showModal()});d.addEventListener('click',function(){d.close()})})();</script>`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`,
  ].join('\n')
  return page({
    title: `${p.name} · ${p.org}`,
    description: `${plainTitle(p)} at ${p.org}. Contact details and a link to book a meeting.`,
    canonical: `${urls(p).card}/`,
    image: `${urls(p).card}/portrait.jpg`,
    up: '../',
    body,
  })
}

export function meetPage(p) {
  const first = esc(p.givenName)
  const url = p.booking.url
  const embed = url + (url.includes('?') ? '&' : '?') + 'gv=true'
  const narrow = Number(p.booking.frameHeightNarrow) || 1320
  const wide = Number(p.booking.frameHeight) || 820
  const body = [
    `<main class="kds">`,
    `<nav class="kds-top"><a class="kds-back" href="../">${icon('back', 18)}${first}'s contact card</a></nav>`,
    `<article class="kds-meet">`,
    `<header class="kds-who">`,
    `<img src="../portrait.jpg" alt="" width="52" height="52">`,
    `<div><h1>Book a meeting with ${first}</h1><p>${esc(p.title)} · ${esc(p.org)}</p></div>`,
    `</header>`,
    `<p class="kds-lede">Pick a time that works for you. It goes straight onto ${first}'s calendar, and Google Calendar emails you the invite.</p>`,
    `<div class="kds-frame" style="--kds-fh:${narrow}px;--kds-fh-wide:${wide}px"><iframe src="${esc(embed)}" title="Pick a time with ${esc(p.name)}" loading="eager" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`,
    `<p class="kds-alt">Calendar not loading? <a href="${esc(url)}" target="_blank" rel="noopener">Open the booking page</a>, or email <a href="mailto:${esc(p.email)}?subject=${encodeURIComponent('Meeting request')}">${esc(p.email)}</a>.</p>`,
    `</article>`,
    foot,
    `</main>`,
  ].join('\n')
  return page({
    title: `Book a meeting with ${p.name}`,
    description: `Pick a time on ${p.givenName}'s calendar. ${plainTitle(p)} at ${p.org}.`,
    canonical: `${urls(p).meet}/`,
    image: `${urls(p).card}/portrait.jpg`,
    up: '../../',
    body,
  })
}

// --- Site --------------------------------------------------------------------
/** Every file of the built site: path under docs/ -> string or Buffer. */
export function outputs(staff = loadStaff()) {
  const src = (name) => readFileSync(join(ROOT, 'src', name))
  const out = {
    CNAME: `${DOMAIN}\n`,
    '.nojekyll': '', // serve the files as they are; no Jekyll pass
    'favicon.svg': src('favicon.svg'),
    'assets/card.css': src('card.css'),
    'assets/kd-mark-white.svg': src('kd-mark-white.svg'),
  }
  for (const p of staff) {
    const qr = qrEncode(urls(p).meet, { ecl: 'M' })
    out[`${p.slug}/index.html`] = cardPage(p)
    out[`${p.slug}/meet/index.html`] = meetPage(p)
    out[`${p.slug}/portrait.jpg`] = p.portraitBytes
    out[`${p.slug}/${p.slug}.vcf`] = vcard(p)
    // Print-ready copies of the code on the card (business cards, slides).
    out[`${p.slug}/meet-qr.svg`] = qrSvg(qr, { quiet: QR_QUIET, title: `Book a meeting with ${p.name}` }) + '\n'
    out[`${p.slug}/meet-qr.png`] = qrPng(qr, { scale: 24, quiet: QR_QUIET })
  }
  return out
}

function main(argv) {
  const check = argv.includes('--check')
  let stale = 0
  for (const [file, content] of Object.entries(outputs())) {
    const path = join(ROOT, 'docs', file)
    const want = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    if (existsSync(path) && readFileSync(path).equals(want)) continue
    stale++
    if (check) { console.error(`stale: docs/${file}`); continue }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, want)
    console.log(`wrote docs/${file}`)
  }
  if (check && stale) { console.error('run `node scripts/build.mjs` and commit the result'); process.exit(1) }
  if (!stale) console.log('docs/ is up to date')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
