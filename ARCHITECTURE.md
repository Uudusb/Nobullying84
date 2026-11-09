# Architecture

This document was written after `REVERSE_ENGINEERING.md` and before product code. It describes a social-intelligence application that can be built from what was actually visible, plus the modules requested for this repository. It does not describe the private Sumbee application, which was not accessible.

## 1. Stack that stays

The repository already runs in production as a school safety form.

| Piece | Decision |
| --- | --- |
| `index.html`, `track.html`, `success.html`, `admin.html` | Unchanged. Same Nunito / sky-teal UI, same Firebase client. |
| Firebase JS SDK 9.23.0 compat, project `school-bullying-report` | Still used only by those pages. |
| `firestore.rules` for `reports`, `publicStatus`, `admins` | Unchanged. Students and staff keep the same guarantees. |
| `firebase.json` hosting of the repo root, `CNAME` `www.safeschool84.mn` | Kept. Hosting ignore list gains `server/**` and `*.db` so a deploy cannot publish the social-intelligence database. |
| `notify-email.gs` | Kept for school notifications. Not reused. That script forwards report text to staff mailboxes. |

No framework replaces the school pages. There is still no bundler.

## 2. Why the new product is not stored in that Firebase project

The live Firestore database holds bullying reports about minors. Putting organizations, social posts, and a second user base into the same project would mix two products and widen access to the school data. Firebase Hosting also cannot run the query, export, and authorization service this product needs. The school client today trusts security rules, which is correct for that form, and is the wrong place to compute cross-platform analytics.

So the social-intelligence product is an addition:

- A small Node.js server, no npm dependencies, using the standard library and `node:sqlite` (DatabaseSync, present in the environment's Node 22). SQLite is a local file, `server/data/si.db`, created at startup, gitignored.
- Static HTML, CSS, and JavaScript under `platform/`, served by that process. Same authoring style as the rest of the repo: no React, no build step.
- Visual language taken from the public Sumbee site (section 6 of the reverse-engineering notes): `#020617` background, `#0f172a` cards, accent `#2C9EFF` to `#127CD4`, Inter and Space Grotesk, glass pill controls, 16px cards. The school palette is not reused here, because it belongs to a different product.
- Mongolian and English UI. Japanese exists on the marketing site only; it is not part of the requested analysis languages, so it is not a product locale.

Run: `npm start` (or `node server/index.js`) on port 8787. The school site continues to be deployed exactly as before.

Official social APIs were not available during inspection, and no tokens are stored. Connectors for Facebook, X, Instagram, Threads, YouTube, and the web are real modules with a shared interface. Their live `fetch` returns "not configured". A mock connector per platform inserts rows flagged `sample = 1`. The UI says "Жишээ өгөгдөл / Sample data" on every such row and on the shell. Sample rows are never labeled as live.

reCAPTCHA, OTP email, and the Sumbee chatbot were observed and are not copied. Registration is a first-party form with server validation. Password reset issues a one-time token. Email delivery is not configured, so the token is returned in the API response and the screen says delivery is local-only. There is no payment module: the public trend prices are catalog marketing, and the checkout provider is unknown. The in-app trend screen is the analytics view requested for this product, not a store.

Sentiment is a local lexicon and pattern scorer for Mongolian (Cyrillic) and English. It is not an external model. Each result stores the label, score, and the five readings the product needs: complaint, satisfaction, product feedback, brand perception, emerging crisis. The screen calls it a local scorer.

## 3. Request path

```
browser
  platform/index.html        marketing
  platform/login.html
  platform/register.html
  platform/app.html          signed-in shell
        |
        |  cookie session, JSON
        v
server/index.js              node:http
  auth.js                    scrypt passwords, session row, cookie
  authz.js                   role → permission, org taken from the session
  db.js                      SQLite, foreign keys, indexes
  sentiment.js
  connectors.js              official stubs + mock
  reports.js                 xlsx (Office Open XML) and PDF (headless Chrome when present)
```

Every tenant table has `organization_id`. The server sets that value from the session's active membership. A client-supplied organization id is ignored. A query that misses the org returns 404, so one tenant cannot probe another's ids. Writes check a permission, not just "is logged in".

## 4. Modules

| Module | Route | Behavior |
| --- | --- | --- |
| Marketing | `/` | Public page in the Sumbee layout: capsule nav, hero, topic cards, source grid, FAQ, contact, chat-style help that answers from local text only. Topic cards open the auth wall. |
| Accounts | `/login`, `/register`, `/api/auth/*` | Register creates a user, an organization, and an owner membership. Login, logout, current user, switch organization, forgot/reset. |
| Executive dashboard | `#/dashboard` | Mentions, posts, comments, engagement, sentiment, mention trend, platform distribution, keywords, influencers, competitor comparison. |
| Social monitoring | `#/monitoring` | One feed: post, platform, author, date, URL, text, engagement, sentiment. Search, platform, sentiment, project, date filters, sort, pagination. Sample badge. |
| Keyword monitoring | `#/keywords` | Projects, include terms, exclude terms, boolean groups (ALL / ANY / NOT), date and platform filters, match preview. |
| Trend topics | `#/trends` | Topic, date range, mentions, engagement, sentiment, platform split, comparison with the previous window of the same length. |
| AI sentiment | `#/sentiment` | Mongolian and English. Distributions plus complaint, satisfaction, product feedback, brand perception, and crisis list. Ad-hoc analyze box. |
| Competitors | `#/competitors` | Competitors and their terms. Share of voice, mentions, sentiment, engagement, topic overlap. |
| Reporting | `#/reports` | Custom range, cadence daily / weekly / monthly, stored report row, PDF and Excel downloads. |
| Team and audit | `#/team` | Members, roles, audit log. |
| Notifications | `#/alerts` | In-app rows when a mock run stores a high crisis score. Mark read. |

The signed-in shell is a dark sidebar, a top bar (org, language, alerts, user), KPI cards, charts drawn as SVG, and tables. Narrow viewports collapse the sidebar into a menu. Each view has a loading state and an error state.

## 5. Roles and permissions

Membership role is one of `owner`, `admin`, `analyst`, `viewer`.

| Permission | viewer | analyst | admin | owner |
| --- | --- | --- | --- | --- |
| read | yes | yes | yes | yes |
| write (projects, keywords, competitors, topics) | | yes | yes | yes |
| ingest | | yes | yes | yes |
| export | | yes | yes | yes |
| members | | | yes | yes |
| audit | | | yes | yes |
| manage (last-owner guard, org name) | | | | yes |

The last owner of an organization cannot be removed or demoted. A user may belong to several organizations and switches the active one; the session stores the active id, and every query uses it.

Denied writes return 403 and append an audit row.

## 6. Data model

Identifiers are UUID text. Timestamps are ISO-8601. SQLite foreign keys are on.

```
organizations
  id, name, created_at

users
  id, email (unique), name, password_hash, created_at

sessions
  id, user_id, organization_id, created_at, expires_at

password_resets
  id, user_id, token_hash, expires_at, used_at

memberships
  id, organization_id, user_id, role, created_at
  unique (organization_id, user_id)

projects
  id, organization_id, name, description, created_at, updated_at

keywords
  id, organization_id, project_id, term, kind ('include' | 'exclude'), created_at

boolean_conditions
  id, organization_id, project_id, bucket ('all' | 'any' | 'not'), term, position

platforms
  code (pk), name, official_status, created_at
  seeded: facebook, x, instagram, threads, youtube, web

posts
  id, organization_id, platform_code, external_id, author_name, author_handle,
  posted_at, url, text, language, likes, comments_count, shares,
  sentiment_label, sentiment_score, crisis_risk, sample, source,
  project_id, created_at
  unique (organization_id, platform_code, external_id)

comments
  id, organization_id, post_id, author_name, text, posted_at,
  sentiment_label, sentiment_score, sample, created_at

sentiment_results
  id, organization_id, target_type ('post' | 'comment' | 'ad-hoc'), target_id,
  language, label, score, complaint, satisfaction, product_feedback,
  brand_perception, crisis_risk, summary, created_at

topics
  id, organization_id, name, created_at

topic_posts
  topic_id, post_id, organization_id
  primary key (topic_id, post_id)

competitors
  id, organization_id, name, created_at

competitor_terms
  id, organization_id, competitor_id, term

influencers
  derived, not stored: group posts by author_handle + platform_code
  inside the active organization

reports
  id, organization_id, name, cadence ('daily' | 'weekly' | 'monthly'),
  date_from, date_to, created_by, created_at

notifications
  id, organization_id, user_id, kind, title, body, read_at, created_at

audit_logs
  id, organization_id, user_id, action, entity, entity_id, detail, created_at

ingestion_runs
  id, organization_id, connector, status, sample, message, created_at
```

Relationships:

- Organization 1—N users through memberships.
- Organization 1—N projects, posts, comments, topics, competitors, reports, notifications, audit rows, ingestion runs.
- Project 1—N keywords and boolean conditions. Posts may point at a project when a run was scoped to one.
- Post 1—N comments. Topic N—N posts. Competitor 1—N terms.
- Sentiment results point at a post, a comment, or an ad-hoc id.

Indexes:

- `memberships (user_id)`, unique `(organization_id, user_id)`
- `posts (organization_id, posted_at)`, `(organization_id, platform_code)`, `(organization_id, sentiment_label)`
- `comments (organization_id, post_id)`
- `keywords (organization_id, project_id)`
- `boolean_conditions (organization_id, project_id)`
- `notifications (organization_id, user_id, read_at)`
- `audit_logs (organization_id, created_at)`
- `sessions (user_id)`

Audit rows are written for register, login, logout, failed login, password reset, membership changes, project and keyword changes, competitor changes, ingestion, exports, and permission denials. Detail text does not include passwords or reset tokens.

Organization isolation is the `organization_id` predicate on every statement, taken from the session. There is no admin connection that skips it. The demo seed creates two organizations so a test can prove one cannot read the other.

## 7. Ingestion

```
connector.fetch({ organizationId, platform, since, until, terms })
  → { mode: 'live' | 'mock' | 'unavailable', items: [...] }
```

- `official:<platform>` checks `process.env.SI_CONNECTOR_<PLATFORM>`. Unset means `{ mode: 'unavailable' }` and zero rows. No network call is made.
- `mock:<platform>` returns a fixed, obvious sample set. Each item has `sample: true` and `source: 'mock'`. The run row stores `sample = 1`.
- After insert, the sentiment scorer fills the post and any comments. If `crisis_risk` is high, a notification is inserted for every member of that organization.

The homepage universe endpoint on sumbee.mn is a public animation feed. It is not an authorized provider and is not called by this server.

## 8. Sentiment

Language: if the text contains Cyrillic letters, `mn`, otherwise `en`. Mixed text is scored with both lists and tagged `mn` when Cyrillic is present.

Score is `(positiveHits - negativeHits) / (positiveHits + negativeHits + 1)`, then clamped to [-1, 1]. Label: `positive` above 0.15, `negative` below -0.15, otherwise `neutral`. English negation (`not`, `no`, `never`) flips the next matched word. Mongolian `биш` flips the previous clause word when it is adjacent.

The five readings are independent 0–1 flags from phrase lists (complaint, satisfaction, product, brand, crisis). Crisis rises further when a crisis phrase and a negative label occur together. A short summary string is stored. The same function serves ad-hoc analysis and stored posts, so the dashboard and the analyzer agree.

## 9. Keyword matching

A post matches a project when all of the following hold:

- Case-insensitive substring.
- Every `all` term is present (empty bucket passes).
- At least one `any` term is present when that bucket is non-empty.
- No `not` term and no `exclude` keyword is present.
- If include-keywords exist and both boolean buckets are empty, at least one include keyword must be present.

The monitoring and keyword screens pass `projectId`, `platform`, `from`, and `to`. The SQL stays parameterized. Boolean text from the user is never evaluated as code.

## 10. Metrics

Inside the active organization and the selected date window:

- Posts: count of posts.
- Comments: count of comments on those posts.
- Mentions: posts + comments.
- Engagement: sum of likes + comments_count + shares.
- Sentiment: mean of post scores, and the share of positive / negative / neutral.
- Mention trend: mentions per day.
- Platform distribution: posts per platform.
- Keywords: top include-terms by how many posts contain them.
- Influencers: authors ordered by engagement.
- Share of voice: a competitor's matching posts divided by the sum of matching posts across the tracked competitors and the organization's own project terms. The denominator is the tracked set, not the whole internet.
- Trend comparison: the same topic metrics on the immediately previous window of equal length.

## 11. Reporting

A report row stores name, cadence, and range. Export rebuilds from posts in that range.

- Excel: a real `.xlsx` (ZIP of Office Open XML) with a summary sheet and a posts sheet. UTF-8 shared strings, so Mongolian text survives.
- PDF: HTML rendered to PDF. When Chrome is installed, the server prints with headless Chrome so Cyrillic is real text. If Chrome is missing, the server returns a small PDF that states the report is text-only ASCII and the Excel file should be used. The response headers still name the file.

Cadence buckets the trend table by day, ISO week, or month.

## 12. Seed

On an empty database the server inserts two sample organizations and sample posts. Every seeded post has `sample = 1`. The login screen lists the sample accounts and their passwords and says they are sample data. Tests also register fresh users so they do not depend on the seed for authorization checks.

## 13. Phased plan

The phases follow the current stack: keep the static school app, add a dependency-free Node service beside it, build the UI as plain pages.

1. **Record.** `REVERSE_ENGINEERING.md`, screenshots, this file. No product code before both documents exist.
2. **Isolate.** Server process, SQLite schema, indexes, session auth, memberships, audit. School files and Firestore rules untouched.
3. **Ingest and score.** Connector interface, unavailable official connectors, mock connectors, Mongolian and English scorer, sample flags.
4. **See.** Marketing pages in the public visual system. Signed-in shell, dashboard KPIs and charts, monitoring feed with search, filters, sort, pagination, loading and error states.
5. **Define.** Projects, include / exclude / boolean terms, trends with a previous-window comparison, competitor share of voice.
6. **Leave with a file.** Reports, PDF, Excel, notifications, team management.
7. **Prove.** `TESTING.md` plus `node --test`, then a browser pass over each module and a cross-organization denial.

Phases 2–7 are implemented in this change. Still out of reach, and left unavailable on purpose:

- Live connector credentials and any official API.
- Email delivery for password reset and for the school-style Apps Script path.
- reCAPTCHA, billing, and the unknown Sumbee checkout.
- The real Sumbee signed-in interface. Our shell follows the public design system and the hero image's general shape (rail, KPI tiles, line, bars, table). It is not a copy of an app we could not open.
- Hosting the Node process on Firebase. The school site stays on Firebase Hosting. Run the new service beside it.
