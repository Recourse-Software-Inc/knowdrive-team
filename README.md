# team.knowdrive.ai

Contact cards for the KnowDrive team, served by GitHub Pages at
[team.knowdrive.ai](https://team.knowdrive.ai/joelauge).

Each person gets two pages:

- `team.knowdrive.ai/<slug>` is the card: portrait, role, contact details, a
  "Save contact" vCard, and a QR code.
- `team.knowdrive.ai/<slug>/meet` is the booking page: their Google Calendar
  appointment schedule, embedded (or an email request, until they have one).
  The QR code on the card opens this page.

## How it is put together

| Path | What it is |
|---|---|
| `staff/<slug>.json`, `staff/<slug>.jpg` | One person's details and portrait. The source. |
| `src/` | Stylesheet and brand assets shared by every card. |
| `scripts/build.mjs` | Writes the site into `docs/`. No dependencies; Node 20 or later. |
| `scripts/qr.mjs` | The QR encoder the build uses. |
| `docs/` | The built site. GitHub Pages serves this folder from `main`. |

`docs/` is committed, so publishing a change is: edit, build, commit, push.

```sh
node scripts/build.mjs               # rebuild docs/
node --test scripts/build.test.mjs   # run the tests
node scripts/build.mjs --check       # fails if docs/ is out of date
```

## Changing a card

Edit `staff/<slug>.json`, rebuild, commit and push. Fields:

- `name`, `givenName`, `familyName`, `title`, `org`, `legalOrg`, `bio`
- `email`, `phone` (optional, international format such as `+1 416 555 0100`),
  `linkedin` (optional)
- `portrait`: a square JPEG in `staff/`, about 256 px
- `booking.url`: the booking-page link of a Google Calendar appointment
  schedule (Google Calendar, Create, Appointment schedule, then "Open booking
  page"). Replacing the schedule only means changing this link; the QR code
  stays the same. Leave it empty for someone who has no schedule yet: their
  `/meet` page then asks for a meeting by email, and starts booking as soon
  as the link is filled in.

## Adding a person

Add `staff/<slug>.json` and `staff/<slug>.jpg`, rebuild, commit and push. The
slug becomes the URL.

A print-ready copy of each QR code is published next to the card, at
`/<slug>/meet-qr.png` and `/<slug>/meet-qr.svg`.
