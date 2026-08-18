// Regenerates the marker-delimited regions of README.md, and every image it points at, from
// the GitHub API. No dependencies: Node's built-in fetch.
// Run it locally with `node .github/scripts/update-readme.mjs`.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const USER = "saeedkolivand"; // ponytail: hardcoded — it's a profile repo for exactly one person
const FILE = "README.md";
const BUILDING = 3;
const FEATURED = 5;
const ACTIVITY = 5;

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
};

// The stats cards need GraphQL (REST has no contribution counts). Needs a token — without one
// those cards are left as they are instead of failing the whole local run.
const gql = async (query) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`POST /graphql -> ${res.status} ${res.statusText}`);
  const { data, errors } = await res.json();
  if (errors) throw new Error(errors.map((e) => e.message).join("; "));
  return data;
};

const raw = async (repo, path) => {
  const res = await fetch(`https://raw.githubusercontent.com/${USER}/${repo}/HEAD/${path}`);
  if (!res.ok) throw new Error(`GET ${repo}/${path} -> ${res.status} ${res.statusText}`);
  return res;
};

// `|` and newlines break markdown table rows. Clip long descriptions — this README is meant
// to be scanned in 30 seconds, and some repo descriptions run to 250 characters.
const cell = (s, max = 130) => {
  const clean = (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
};

const replaceRegion = (md, key, body) => {
  const re = new RegExp(`(<!-- ${key}:START -->)[\\s\\S]*?(<!-- ${key}:END -->)`);
  if (!re.test(md)) throw new Error(`${FILE} is missing the <!-- ${key}:START --> / <!-- ${key}:END --> marker pair`);
  return md.replace(re, (_, open, close) => `${open}\n${body}\n${close}`);
};

const line = (e) => {
  const repo = `[${e.repo.name.replace(`${USER}/`, "")}](https://github.com/${e.repo.name})`;
  const on = new Date(e.created_at).toISOString().slice(0, 10);
  switch (e.type) {
    case "PushEvent": {
      // The public events feed no longer ships payload.size or payload.commits, so there is
      // no commit count to report — show the branch instead of guessing a number.
      const branch = e.payload.ref?.replace("refs/heads/", "");
      return `\`${on}\` &nbsp; Pushed to ${branch ? `\`${branch}\` in ` : ""}${repo}`;
    }
    case "PullRequestEvent":
      // Build the URL rather than trusting payload.pull_request.html_url — the public
      // events feed does not always populate it.
      return `\`${on}\` &nbsp; ${e.payload.action === "closed" ? "Merged" : "Opened"} PR [#${e.payload.number}](https://github.com/${e.repo.name}/pull/${e.payload.number}) in ${repo}`;
    case "ReleaseEvent":
      return `\`${on}\` &nbsp; Released [${e.payload.release.tag_name}](${e.payload.release.html_url}) of ${repo}`;
    case "CreateEvent":
      return e.payload.ref_type === "repository" ? `\`${on}\` &nbsp; Created ${repo}` : null;
    default:
      return null;
  }
};

// Exclude the profile repo itself: this workflow pushes to it daily, so it would
// permanently sit at the top of "Currently Building" as its own most-recent project.
const isSelf = (name) => name === USER || name === `${USER}/${USER}`;

const repos = (await api(`/users/${USER}/repos?per_page=100&sort=pushed`)).filter(
  (r) => !r.fork && !r.archived && !isSelf(r.name),
);
const events = (await api(`/users/${USER}/events/public?per_page=100`)).filter((e) => !isSelf(e.repo.name));

// GitHub's `language` field is whichever language has the most bytes, so a Tauri app reads as
// "TypeScript" and every project looks the same. Repo topics are hand-curated and say what the
// thing is actually built with — ordered here most-distinctive first, so a row leads with
// Tauri or SwiftUI rather than with TypeScript.
const TECH = [
  // "swift" sits late: a repo tagged both swiftui and swift should lead with the framework.
  ["tauri", "Tauri"], ["rust", "Rust"], ["swiftui", "SwiftUI"], ["widgetkit", "WidgetKit"],
  ["threejs", "Three.js"], ["webgl", "WebGL"], ["gsap", "GSAP"], ["tonejs", "Tone.js"], ["electron", "Electron"],
  ["stream-deck", "Stream Deck"], ["streamdeck", "Stream Deck"], ["nextjs", "Next.js"], ["react", "React"],
  ["vue", "Vue"], ["svelte", "Svelte"], ["angular", "Angular"], ["tailwindcss", "Tailwind"], ["nodejs", "Node.js"],
  ["typescript", "TypeScript"], ["javascript", "JavaScript"], ["python", "Python"], ["swift", "Swift"], ["macos", "macOS"],
  ["design-system", "Design System"], ["local-first", "Local-first"],
];

const stackOf = (repo, max = 3) => {
  const topics = repo.topics ?? [];
  const named = [...new Set(TECH.filter(([slug]) => topics.includes(slug)).map(([, name]) => name))];
  return (named.length ? named.slice(0, max) : [repo.language].filter(Boolean)).join(" · ") || "—";
};

const building = repos
  .slice(0, BUILDING)
  .map((r) => `- **[${r.name}](${r.html_url})** — ${cell(r.description) || "_no description yet_"} \`${stackOf(r, 2)}\``)
  .join("\n");

const featured = [
  "| Project | What it is | Stack | ★ |",
  "| :-- | :-- | :-- | --: |",
  ...[...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, FEATURED)
    .map((r) => `| **[${r.name}](${r.html_url})** | ${cell(r.description) || "—"} | ${stackOf(r)} | ${r.stargazers_count} |`),
].join("\n");

// ponytail: dedupe by repo so one busy day doesn't fill the whole list with the same project
// Render first, then dedupe — otherwise an ignored event type (a star, a fork) burns the
// repo's slot and hides the real push that follows it.
// ponytail: dedupe on repo+type, not repo alone. Working hard on two projects otherwise
// collapses into two lines and reads as inactivity.
const seen = new Set();
const shown = events
  .map((e) => ({ key: `${e.repo.name}:${e.type}`, text: line(e) }))
  .filter((e) => e.text && !seen.has(e.key) && seen.add(e.key))
  .slice(0, ACTIVITY);
const activity = shown.map((e) => e.text).join("\n\n");

// --- Look and feel -----------------------------------------------------------------------
// The portfolio's comic art direction (iamsaeed.dev), printed on black stock: the paper is
// near-black, the ink is that cream, and the red still sits behind the type like a
// misregistered run. Dark either way, so it reads the same in both GitHub themes.
const PAPER = "#15120f";
const INK = "#f2ead9";
const SHADOW = "#e2574c";
const RED = "#e2574c";
const TEAL = "#43c2b7";
const MUTED = "#a2988a";
const FONT = "'Segoe UI',Ubuntu,Helvetica,sans-serif";
const HEAVY = "'Arial Black','Helvetica Neue',Impact,sans-serif";
const MONO = "ui-monospace,Consolas,monospace";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, { size = 14, weight = 400, fill = INK, anchor = "start", font = FONT, spacing = 0, extra = "" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ""}${extra}>${esc(s)}</text>`;

// A panel is inked paper with a hard offset shadow — no blur, no gradient, like print.
const svgDoc = (w, h, label, body, { pattern = true } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<defs><pattern id="tone" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="${INK}" opacity="0.06"/></pattern></defs>
<rect x="6" y="6" width="${w - 6}" height="${h - 6}" fill="${SHADOW}"/>
<rect x="1.5" y="1.5" width="${w - 9}" height="${h - 9}" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
${pattern ? `<rect x="3" y="3" width="${w - 12}" height="${h - 12}" fill="url(#tone)"/>` : ""}
${body}
</svg>
`;

// Panel titles: heavy, uppercase, tracked out, with the red rule underneath that the portfolio
// uses on its section headings.
const panelTitle = (title, w) =>
  [
    text(24, 38, title.toUpperCase(), { size: 19, weight: 900, font: HEAVY, spacing: 0.5 }),
    `<rect x="24" y="48" width="${w - 48}" height="3" fill="${RED}"/>`,
  ].join("\n");

const card = (title, body) => svgDoc(400, 170, title, `${panelTitle(title, 400)}\n${body}`);

// --- Hero --------------------------------------------------------------------------------
// Bangers is the display face on the portfolio, so the name has to be set in it. Embedded as a
// data URI: an SVG loaded through <img> cannot fetch a font, and GitHub proxies these anyway.
const heroCard = async () => {
  const font = Buffer.from(await (await raw("saeed-kolivand-portfolio", "public/fonts/Bangers-Regular.ttf")).arrayBuffer()).toString("base64");
  const W = 900, H = 300;
  const display = (x, y, s, size, fill) =>
    `<text x="${x}" y="${y}" font-family="Bangers" font-size="${size}" fill="${fill}" text-anchor="middle">${esc(s)}</text>`;

  await writeFile(
    "assets/hero.svg",
    svgDoc(W, H, "Saeed Kolivand — Front-End Engineer, Cologne", [
      `<style>@font-face{font-family:'Bangers';font-style:normal;font-weight:400;src:url(data:font/truetype;base64,${font}) format('truetype');}</style>`,
      text(W / 2, 62, "COLOGNE, GERMANY", { size: 13, fill: MUTED, anchor: "middle", font: MONO, spacing: 2.5 }),
      // Red sits a few pixels behind the ink, the way a misregistered print run looks.
      display(W / 2 + 4, 152, "SAEED KOLIVAND", 88, RED),
      display(W / 2, 148, "SAEED KOLIVAND", 88, INK),
      `<rect x="150" y="176" width="${W - 300}" height="42" fill="${RED}"/>`,
      `<rect x="150" y="176" width="${W - 300}" height="42" fill="none" stroke="${INK}" stroke-width="3"/>`,
      text(W / 2, 204, "FRONT-END ENGINEER", { size: 18, weight: 900, fill: INK, anchor: "middle", font: HEAVY, spacing: 1.5 }),
      text(W / 2, 248, "Local-first AI tooling · React & Next.js on the web · Rust + Tauri on the desktop", { size: 14, fill: INK, anchor: "middle" }),
      text(W / 2, 272, "iamsaeed.dev", { size: 13, fill: TEAL, anchor: "middle", font: MONO, spacing: 1.5 }),
    ].join("\n")),
  );
  console.log("Wrote assets/hero.svg.");
};

// --- Product shots -------------------------------------------------------------------------
// Copied out of the project repos rather than hotlinked, so reorganising docs/ over there can
// never leave a broken image here — the workflow fails loudly instead and the copy stays put.
const SHOTS = [
  ["ai-job-hunter-app", "branding/marketing/01-hero.png", "job-hunter.png"],
  ["claude-usage-mac", "docs/gallery/widget-medium.png", "claude-usage-mac.png"],
  ["saeed-kolivand-portfolio", "docs/readme/plates/00-cover.png", "portfolio.png"],
];

const shots = async () => {
  await mkdir("assets/shots", { recursive: true });
  for (const [repo, path, out] of SHOTS) {
    const bytes = Buffer.from(await (await raw(repo, path)).arrayBuffer());
    await writeFile(`assets/shots/${out}`, bytes);
    console.log(`Wrote assets/shots/${out} (${Math.round(bytes.length / 1024)}KB from ${repo}).`);
  }
};

// --- Stats cards ---------------------------------------------------------------------------
// Replaces the github-readme-stats cards, which are rate-limited on the shared Vercel
// instance and render as "Maximum retries exceeded" most of the day.
const statsCards = async () => {
  const { user } = await gql(`{ user(login: "${USER}") {
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes { stargazerCount languages(first: 8, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } } }
    }
    pullRequests { totalCount }
    issues { totalCount }
    contributionsCollection { totalCommitContributions }
  } }`);

  const nodes = user.repositories.nodes;
  const n = (v) => v.toLocaleString("en-US");
  const rows = [
    ["Stars earned", nodes.reduce((sum, r) => sum + r.stargazerCount, 0)],
    ["Commits, past year", user.contributionsCollection.totalCommitContributions],
    ["Pull requests", user.pullRequests.totalCount],
    ["Issues", user.issues.totalCount],
    ["Public repositories", user.repositories.totalCount],
  ];
  const stats = card(
    "The Numbers",
    rows
      .map(([label, value], i) => {
        const y = 76 + i * 20;
        return text(24, y, label, { fill: MUTED }) + text(376, y, n(value), { weight: 900, font: HEAVY, anchor: "end" });
      })
      .join("\n"),
  );

  // Bytes per language across every public repo — same measure the top-langs card used.
  const bytes = {};
  for (const { languages } of nodes) for (const e of languages.edges) bytes[e.node.name] = (bytes[e.node.name] ?? 0) + e.size;
  const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, size]) => ({ name, pct: (size / total) * 100, color: LANG_COLOR[name] ?? MUTED }));

  let x = 24;
  const segments = top
    .map(({ pct, color }) => {
      const w = (pct / 100) * 352;
      const seg = `<rect x="${x.toFixed(1)}" y="66" width="${w.toFixed(1)}" height="14" fill="${color}"/>`;
      x += w;
      return seg;
    })
    .join("\n");
  const legend = top
    .map(({ name, pct, color }, i) => {
      const cx = 30 + (i % 2) * 185;
      const cy = 104 + Math.floor(i / 2) * 22;
      return `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" fill="${color}" stroke="${INK}" stroke-width="1.5"/>` +
        text(cx + 13, cy + 4, `${name} ${pct.toFixed(1)}%`, { fill: INK, size: 13 });
    })
    .join("\n");
  const langs = card(
    "Most Used Languages",
    `<rect x="24" y="66" width="352" height="14" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>
${segments}
<rect x="24" y="66" width="352" height="14" fill="none" stroke="${INK}" stroke-width="2"/>
${legend}`,
  );

  await writeFile("assets/github-stats.svg", stats);
  await writeFile("assets/top-langs.svg", langs);
  console.log(`Wrote assets/github-stats.svg and assets/top-langs.svg (${top.length} languages).`);
};

// The contribution calendar is capped at 12 months per query, so the whole history is one
// request with a year alias each.
const streakCard = async () => {
  const { user } = await gql(`{ user(login: "${USER}") { createdAt } }`);
  const first = new Date(user.createdAt);
  const today = new Date().toISOString().slice(0, 10);
  const years = [];
  for (let y = first.getUTCFullYear(); y <= Number(today.slice(0, 4)); y++) years.push(y);

  const calendar = `contributionCalendar { weeks { contributionDays { date contributionCount } } }`;
  const data = await gql(
    `{ user(login: "${USER}") {
      ${years.map((y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") { ${calendar} }`).join("\n      ")}
    } }`,
  );

  // One flat day list, oldest first. Weeks overhang into the future, so drop days past today.
  const days = years
    .flatMap((y) => data.user[`y${y}`].contributionCalendar.weeks.flatMap((w) => w.contributionDays))
    .filter((d) => d.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const total = days.reduce((sum, d) => sum + d.contributionCount, 0);

  let longest = { length: 0 }, run = 0;
  days.forEach((d, i) => {
    run = d.contributionCount > 0 ? run + 1 : 0;
    if (run > longest.length) longest = { length: run, from: days[i - run + 1].date, to: d.date };
  });

  // A quiet today does not break the streak — it just hasn't been earned yet, same as the
  // card this replaces. A quiet yesterday does.
  let end = days.length - 1;
  if (days[end]?.contributionCount === 0) end--;
  let start = end;
  while (start >= 0 && days[start].contributionCount > 0) start--;
  const current = { length: end - start, from: days[start + 1]?.date, to: days[end]?.date };
  // Cheap check on the two loops above: the current streak is one of the runs longest saw.
  if (current.length > longest.length) throw new Error(`streak math is off: current ${current.length} > longest ${longest.length}`);

  const day = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const opts = { month: "short", day: "numeric", timeZone: "UTC" };
    if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  };
  const range = (s) => (s.length ? (s.from === s.to ? day(s.from) : `${day(s.from)} – ${day(s.to)}`) : "—");

  // Sized so a phone, which renders this 720-wide card at ~0.5x, still lands near 10px.
  const column = (x, value, label, dates) =>
    [
      text(x, 124, value.toLocaleString("en-US"), { size: 46, weight: 900, font: HEAVY, anchor: "middle" }),
      text(x, 174, label.toUpperCase(), { size: 14, weight: 900, fill: RED, anchor: "middle", font: HEAVY, spacing: 1 }),
      text(x, 200, dates, { size: 16, fill: MUTED, anchor: "middle" }),
    ].join("\n");

  const streak = svgDoc(720, 236, "GitHub contribution streak", [
    panelTitle("Shipping Record", 720),
    `<line x1="248" y1="66" x2="248" y2="214" stroke="${INK}" stroke-width="2"/>`,
    `<line x1="472" y1="66" x2="472" y2="214" stroke="${INK}" stroke-width="2"/>`,
    column(136, total, "Contributions", `${day(user.createdAt.slice(0, 10))} – today`),
    // The ring is the current streak's badge — gap at the top for the flame.
    `<circle cx="360" cy="108" r="46" fill="none" stroke="${RED}" stroke-width="5"/>`,
    `<rect x="344" y="56" width="32" height="14" fill="${PAPER}"/>`,
    text(360, 68, "🔥", { size: 18, anchor: "middle" }),
    column(360, current.length, "Current Streak", range(current)),
    column(584, longest.length, "Longest Streak", range(longest)),
  ].join("\n"));

  await writeFile("assets/streak.svg", streak);
  console.log(`Wrote assets/streak.svg (${total} contributions, ${current.length}-day current, ${longest.length}-day longest).`);
};

// --- Stack strips and badges ---------------------------------------------------------------
// Inked monochrome glyphs, like a printed page — brand colours would fight the paper, and the
// pale ones (JavaScript yellow) are unreadable on it.
const STACK = {
  build: ["typescript", "javascript", "react", "nextdotjs", "nodedotjs", "rust", "tailwindcss", "jest"],
  ship: ["git", "github", "visualstudiocode", "vite", "figma", "tauri"],
};

const LANG_COLOR = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Rust: "#dea584", Swift: "#F05138",
  CSS: "#563d7c", SCSS: "#c6538c", HTML: "#e34c26", Python: "#3572A5", Shell: "#89e051",
  Vue: "#41b883", Svelte: "#ff3e00", Go: "#00ADD8", Java: "#b07219", Kotlin: "#A97BFF",
  Dart: "#00B4AB", Ruby: "#701516", C: "#555555", "C++": "#f34b7d", Typst: "#239dad", MDX: "#fcb32c",
};

const iconPath = async (slug) => {
  const res = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`);
  if (!res.ok) throw new Error(`simple-icons ${slug} -> ${res.status}`);
  return (await res.text()).match(/<path[^>]*\sd="([^"]+)"/)[1];
};

const stackStrip = async (name, slugs, extras = []) => {
  const SIZE = 38, GAP = 24, PAD = 26;
  const paths = await Promise.all(slugs.map(iconPath));
  const at = (i) => PAD + i * (SIZE + GAP);
  const glyphs = paths.map((d, i) => `<path d="${d}" fill="${INK}" transform="translate(${at(i)},26) scale(${SIZE / 24})"/>`);
  // ComfyUI has no simple-icon, so its logomark is vendored in assets/ and inked to match.
  const nested = await Promise.all(
    extras.map(async (file, i) => {
      const svg = await readFile(file, "utf8");
      const box = svg.match(/viewBox="([^"]+)"/)[1];
      const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/fill="#[0-9A-Fa-f]{6}"/g, `fill="${INK}"`);
      return `<svg x="${at(slugs.length + i)}" y="26" width="${SIZE}" height="${SIZE}" viewBox="${box}">${inner}</svg>`;
    }),
  );
  const count = slugs.length + extras.length;
  await writeFile(`assets/${name}.svg`, svgDoc(PAD * 2 + count * SIZE + (count - 1) * GAP, 90, `${name} stack`, [...glyphs, ...nested].join("\n")));
  console.log(`Wrote assets/${name}.svg (${count} icons).`);
};

// shields.io's job, done on paper: inked box, offset shadow, brand glyph, tracked-out caps.
const badge = async (name, label, slug, color) => {
  const H = 34, CW = 8.6, logo = 15, w = 16 + logo + 9 + label.length * CW + 16;
  await writeFile(
    `assets/badge-${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 5}" height="${H + 5}" viewBox="0 0 ${w + 5} ${H + 5}" role="img" aria-label="${esc(label)}">
<rect x="5" y="5" width="${w}" height="${H}" fill="${SHADOW}"/>
<rect x="1.5" y="1.5" width="${w - 3}" height="${H - 3}" fill="${color}" stroke="${INK}" stroke-width="3"/>
<path d="${await iconPath(slug)}" fill="${INK}" transform="translate(16,${(H - logo) / 2}) scale(${logo / 24})"/>
<text x="${16 + logo + 9}" y="${H / 2 + 5}" font-family="${HEAVY}" font-size="12" font-weight="900" fill="${INK}" letter-spacing="1.4" textLength="${(label.length * CW).toFixed(1)}" lengthAdjust="spacing">${esc(label)}</text>
</svg>
`,
  );
};

await mkdir("assets", { recursive: true });
await heroCard();
await shots();
await stackStrip("stack-build", STACK.build);
await stackStrip("stack-ship", STACK.ship, ["assets/comfyui.svg"]);
await Promise.all([
  badge("portfolio", "IAMSAEED.DEV", "googlechrome", RED),
  badge("linkedin", "LINKEDIN", "linkedin", "#0A66C2"),
  badge("email", "EMAIL", "gmail", PAPER),
]);
console.log("Wrote assets/badge-*.svg.");

if (process.env.GITHUB_TOKEN) {
  await statsCards();
  await streakCard();
} else console.warn("No GITHUB_TOKEN — leaving the stat cards in assets/ unchanged.");

let md = await readFile(FILE, "utf8");
md = replaceRegion(md, "BUILDING", building);
md = replaceRegion(md, "FEATURED", featured);
md = replaceRegion(md, "ACTIVITY", activity);
await writeFile(FILE, md);

console.log(`Updated ${FILE}: ${BUILDING} building, ${FEATURED} featured, ${shown.length} activity entries.`);
