# Testing

Date: 2026-11-10. App under test: `node server/index.js` on `127.0.0.1:8787`, empty SQLite file, demo seed on. School pages were not part of this server. They were left unchanged and were not redeployed.

## Automated

Command: `npm test` (`node --test tests/platform.test.js`).

Result: 7 tests, 7 passed, 0 failed.

| Test | What it checked | Result |
| --- | --- | --- |
| Local sentiment | Mongolian complaint is `mn` / negative / complaint. English praise is `en` / positive. English scandal + boycott + terrible is negative with crisis at least 0.75. | Pass |
| Sample owner | Wrong password is 401. Owner login returns Жишээ Альфа. Dashboard has posts, mentions, a trend, platforms, and `sample: true`, `live: false`. Search `скандал` returns a sample row. YouTube filter stays on YouTube. Page size 2 paginates. | Pass |
| Roles | Viewer `POST /api/projects` is 403. Analyst creates a project, include `сарнай`, exclude `ажлын зар`, ANY `кофе`. Matches are sample rows and none contain the excluded phrase. Keyword delete works. | Pass |
| Organization isolation | Beta owner gets 404 for an Alpha post id. Beta feed has Хөх тэнгэр and no Сарнай. Alpha share of voice for Алтан аяга is between 0 and 1. | Pass |
| Connectors | `official:facebook` inserts nothing and reports unavailable. `mock:instagram` inserts sample rows. A second run inserts 0. | Pass |
| Reports and owner guard | Weekly report. Excel starts with `PK` and contains `Жишээ тайлан` and `SAMPLE DATA`. PDF starts with `%PDF`. Demoting the only owner is 409. Topic Кофены чанар has mentions. A notification can be marked read. | Pass |
| Register and reset | New organization sees 0 posts. Forgot-password returns `delivered: false` and a local token. Reset then login works. Ad-hoc Mongolian text is satisfaction, `liveModel: false`. | Pass |

## Browser

Chrome (Puppeteer, system Chrome) against the running server.

| Flow | Result |
| --- | --- |
| Marketing page, MN capsule nav, click a topic card | Auth wall appears with Нэвтрэх and Бүртгүүлэх. |
| Login as `owner.alpha@sample.local` | Dashboard shows the sample banner, KPIs (mentions, posts, comments, engagement, average), mention line, sentiment bars, platform bars, keywords, influencers, competitor bars. |
| Monitoring search `скандал` | One row, negative badge, sample badge, pager `1 / 1`. |
| Open that row | Modal shows the text, sample flag, and URL. |
| Create project `UI төсөл` | Project card appears. |
| Sentiment box with a Mongolian complaint | Result line `mn · negative · гомдол`, crisis 0. Screen says `local-lexicon` and `live model: false`. |
| Competitors | Share of voice bars for own, Алтан аяга, Номин талх. |
| Run mock ingestion, save report `UI тайлан` | Report row gets PDF and Excel links. Official connectors listed as not configured. |
| Language toggle | Shell switches to English, including the sample banner. Sentiment nav reads Sentiment, not the KPI label. |
| 390px width, open menu | Sidebar is 240px and does not cover Гарах. |
| Logout | Returns to `/login`. |
| Viewer creates a project | Red error: Permission denied. No project is created. |
| Contact form and local help widget | Contact responds that mail is not configured and the message was not stored. Help answers from the local list. Checked by reading the handlers and the marketing script; the contact POST is the same path the API test style would hit. Not repeated as its own automated case. |

PDF text extraction beyond the `%PDF` header and the Excel UTF-8 check was not done. Chrome produced the PDF (the export test finished in well under a second, which is the Chrome path, not the ASCII fallback).

## Not verified

- The signed-in product on `https://sumbee.mn/`. No account was used, and none was created there.
- Sumbee login, registration OTP, forgot-password email, contact delivery, and `/Account/Ask`.
- Official social APIs. They stay unavailable until `SI_CONNECTOR_<PLATFORM>` exists, and this build still does not call them.
- Email delivery for this app's password reset. The token is returned in the response on purpose.
- Live Firestore data for the school app. Rules and pages were not executed against Google.
- Firebase Hosting of this branch. `firebase.json` now ignores `server/**` and database files; a deploy was not run.
- Japanese UI. The public Sumbee site has it. This product ships Mongolian and English only.
- Payment. The public trend prices were not turned into a checkout.
- A second browser engine. Chrome only.
- Mobile layout below the menu button on every module. Dashboard, monitoring, sentiment, reports, and the auth wall were seen at desktop width. The signed-in menu was opened at 390px.
