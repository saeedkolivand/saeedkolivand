// Regenerates the marker-delimited regions of README.md from the GitHub API.
// No dependencies: Node's built-in fetch. Run it locally with `node .github/scripts/update-readme.mjs`.
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

// The stats region needs GraphQL (REST has no contribution counts). Needs a token —
// without one the region is left as-is instead of failing the whole local run.
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

const building = repos
  .slice(0, BUILDING)
  .map((r) => `- **[${r.name}](${r.html_url})** — ${cell(r.description) || "_no description yet_"} \`${r.language ?? "—"}\``)
  .join("\n");

const featured = [
  "| Project | What it is | Stack | ★ |",
  "| :-- | :-- | :-- | --: |",
  ...[...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, FEATURED)
    .map((r) => `| **[${r.name}](${r.html_url})** | ${cell(r.description) || "—"} | ${r.language ?? "—"} | ${r.stargazers_count} |`),
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

// tokyonight, so the generated cards match the streak card next to them.
const BG = "#1a1b27";
const TITLE = "#70a5fd";
const LABEL = "#38bdae";
const VALUE = "#a9fef7";
const FONT = "'Segoe UI',Ubuntu,sans-serif";

// ponytail: linguist colors for the languages that actually show up, grey for the rest
const LANG_COLOR = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Rust: "#dea584", Swift: "#F05138",
  CSS: "#563d7c", SCSS: "#c6538c", HTML: "#e34c26", Python: "#3572A5", Shell: "#89e051",
  Vue: "#41b883", Svelte: "#ff3e00", Go: "#00ADD8", Java: "#b07219", Kotlin: "#A97BFF",
  Dart: "#00B4AB", Ruby: "#701516", C: "#555555", "C++": "#f34b7d", Typst: "#239dad", MDX: "#fcb32c",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, { size = 14, weight = 400, fill = VALUE, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const svgDoc = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<rect x="0" y="0" width="${w}" height="${h}" rx="6" fill="${BG}"/>
${body}
</svg>
`;
const card = (title, body) => svgDoc(400, 170, title, `${text(25, 34, title, { size: 18, weight: 600, fill: TITLE })}\n${body}`);

// Replaces the github-readme-stats cards, which are rate-limited on the shared Vercel
// instance and render as "Maximum retries exceeded" most of the day.
const statsRegion = async () => {
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
    ["Total Stars Earned", nodes.reduce((sum, r) => sum + r.stargazerCount, 0)],
    ["Total Commits (past year)", user.contributionsCollection.totalCommitContributions],
    ["Total PRs", user.pullRequests.totalCount],
    ["Total Issues", user.issues.totalCount],
    ["Public Repositories", user.repositories.totalCount],
  ];
  const stats = card(
    "Saeed's GitHub Stats",
    rows
      .map(([label, value], i) => {
        const y = 66 + i * 22;
        return text(25, y, label, { fill: LABEL }) + text(375, y, n(value), { weight: 600, anchor: "end" });
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
    .map(([name, size]) => ({ name, pct: (size / total) * 100, color: LANG_COLOR[name] ?? "#858585" }));

  // The bar is clipped to a rounded rect so the segments can stay plain rects.
  let x = 25;
  const segments = top
    .map(({ pct, color }) => {
      const w = (pct / 100) * 350;
      const seg = `<rect x="${x.toFixed(1)}" y="52" width="${w.toFixed(1)}" height="10" fill="${color}"/>`;
      x += w;
      return seg;
    })
    .join("\n");
  const legend = top
    .map(({ name, pct, color }, i) => {
      const cx = 30 + (i % 2) * 185;
      const cy = 92 + Math.floor(i / 2) * 24;
      return `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}"/>` + text(cx + 12, cy + 4, `${name} ${pct.toFixed(1)}%`, { fill: LABEL });
    })
    .join("\n");
  const langs = card(
    "Most Used Languages",
    `<clipPath id="bar"><rect x="25" y="52" width="350" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)"><rect x="25" y="52" width="350" height="10" fill="#2a2b3d"/>
${segments}</g>
${legend}`,
  );

  await mkdir("assets", { recursive: true });
  await writeFile("assets/github-stats.svg", stats);
  await writeFile("assets/top-langs.svg", langs);
  console.log(`Wrote assets/github-stats.svg and assets/top-langs.svg (${top.length} languages).`);
};

// Same idea for the streak card: the contribution calendar is one GraphQL query per year
// (the API caps a range at 12 months), so the whole history is one request with aliases.
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
  const range = (s) => (s.length ? (s.from === s.to ? day(s.from) : `${day(s.from)} - ${day(s.to)}`) : "—");

  const column = (x, value, label, dates, color) =>
    [
      // Sized so a phone, which renders this 720-wide card at ~0.5x, still lands near 10px.
      text(x, 97, value.toLocaleString("en-US"), { size: 42, weight: 700, fill: color, anchor: "middle" }),
      text(x, 152, label, { size: 20, weight: 600, fill: color, anchor: "middle" }),
      text(x, 181, dates, { size: 18, fill: LABEL, anchor: "middle" }),
    ].join("\n");

  const streak = svgDoc(
    720,
    210,
    "GitHub contribution streak",
    [
      `<line x1="240" y1="30" x2="240" y2="180" stroke="#2a2b3d" stroke-width="1"/>`,
      `<line x1="480" y1="30" x2="480" y2="180" stroke="#2a2b3d" stroke-width="1"/>`,
      column(120, total, "Total Contributions", `${day(user.createdAt.slice(0, 10))} - Present`, TITLE),
      // The ring is the current streak's badge — gap at the top for the flame, like the original.
      `<circle cx="360" cy="84" r="48" fill="none" stroke="${TITLE}" stroke-width="5"/>`,
      `<rect x="344" y="28" width="32" height="16" fill="${BG}"/>`,
      text(360, 42, "🔥", { size: 18, anchor: "middle" }),
      column(360, current.length, "Current Streak", range(current), "#bf91f3"),
      column(600, longest.length, "Longest Streak", range(longest), TITLE),
    ].join("\n"),
  );

  await writeFile("assets/streak.svg", streak);
  console.log(`Wrote assets/streak.svg (${total} contributions, ${current.length}-day current, ${longest.length}-day longest).`);
};

// --- Cards that need no GitHub data: the header, the stack strips and the link badges. ---

const MONO = "ui-monospace,'Cascadia Code','Fira Code',Consolas,monospace";
const TAGLINES = [
  "Front-End Engineer, 6+ years",
  "React | Next.js | TypeScript",
  "Building local-first AI dev tools",
  "Clean architecture, shipped products",
];

// textLength pins the rendered width to what the geometry below assumes, so the typing clip
// and the cursor stay aligned whichever monospace font the viewer actually has.
const mono = (x, y, s, fill, size = 16, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" fill="${fill}" textLength="${(s.length * size * 0.6).toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve"${extra}>${esc(s)}</text>`;

const headerCard = async () => {
  const SIZE = 16, CW = SIZE * 0.6, SLOT = 4, RUN = TAGLINES.length * SLOT, X = 20 + 2 * CW, Y = 124;
  // Each line owns a 4s slot of one shared loop: type for 1.2s, hold, wipe, then wait its turn.
  const at = (s) => (s / RUN).toFixed(4);
  const keyTimes = `0;${at(1.2)};${at(3.4)};${at(3.6)};1`;
  const anim = (attr, values, i) =>
    `<animate attributeName="${attr}" values="${values}" keyTimes="${keyTimes}" dur="${RUN}s" begin="${i * SLOT}s" repeatCount="indefinite"/>`;

  const typed = TAGLINES.map((t, i) => {
    const w = t.length * CW;
    return `<clipPath id="type${i}"><rect x="${X}" y="${Y - 14}" width="0" height="20">${anim("width", `0;${w};${w};0;0`, i)}</rect></clipPath>
${mono(X, Y, t, LABEL, SIZE, ` clip-path="url(#type${i})"`)}
<rect x="${X}" y="${Y - 13}" width="${CW}" height="18" fill="${TITLE}" opacity="0">${anim("x", `${X};${X + w};${X + w};${X};${X}`, i)}${anim("opacity", "1;1;1;0;0", i)}</rect>`;
  }).join("\n");

  await writeFile(
    "assets/header.svg",
    svgDoc(620, 160, "Saeed Kolivand — Front-End Engineer", [
      `<rect x="0" y="0" width="620" height="36" rx="8" fill="#16161e"/><rect x="0" y="28" width="620" height="8" fill="#16161e"/>`,
      `<circle cx="20" cy="18" r="5" fill="#ff5f56"/><circle cx="38" cy="18" r="5" fill="#ffbd2e"/><circle cx="56" cy="18" r="5" fill="#27c93f"/>`,
      mono(310 - "saeed@github — zsh".length * 4.2, 23, "saeed@github — zsh", "#565f89", 14),
      mono(20, 68, "$ ", "#9ece6a") + mono(20 + 2 * CW, 68, "whoami", VALUE),
      mono(20, 96, "Saeed Kolivand · Front-End Engineer · Cologne", TITLE),
      mono(20, Y, "$ ", "#9ece6a"),
      // Blink lives on the group, so it multiplies with each cursor's own visibility window.
      `<g><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.49;0.5;1" dur="1.06s" repeatCount="indefinite"/>\n${typed}</g>`,
    ].join("\n")),
  );
  console.log("Wrote assets/header.svg.");
};

// Brand hex per icon: near-black brands (Next.js, GitHub) get a light stand-in so they stay
// visible on the dark card, and Rust reuses the tone the language bar already uses.
const STACK = {
  build: [["typescript", "#3178C6"], ["javascript", "#F7DF1E"], ["react", "#61DAFB"], ["nextdotjs", "#FFFFFF"],
    ["nodedotjs", "#5FA04E"], ["rust", "#DEA584"], ["tailwindcss", "#06B6D4"], ["jest", "#C21325"]],
  ship: [["git", "#F05032"], ["github", "#FFFFFF"], ["visualstudiocode", "#007ACC"], ["vite", "#646CFF"],
    ["figma", "#F24E1E"], ["tauri", "#24C8DB"]],
};

const iconPath = async (slug) => {
  const res = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`);
  if (!res.ok) throw new Error(`simple-icons ${slug} -> ${res.status}`);
  return (await res.text()).match(/<path[^>]*\sd="([^"]+)"/)[1];
};

const stackStrip = async (name, icons, extras = []) => {
  const SIZE = 40, GAP = 22, PAD = 22;
  const paths = await Promise.all(icons.map(([slug]) => iconPath(slug)));
  const at = (i) => PAD + i * (SIZE + GAP);
  const glyphs = paths.map((d, i) => `<path d="${d}" fill="${icons[i][1]}" transform="translate(${at(i)},20) scale(${SIZE / 24})"/>`);
  // ComfyUI has no simple-icon, so its logomark is vendored in assets/ and nested as-is.
  const nested = await Promise.all(
    extras.map(async (file, i) => {
      const raw = await readFile(file, "utf8");
      const box = raw.match(/viewBox="([^"]+)"/)[1];
      const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
      return `<svg x="${at(icons.length + i)}" y="20" width="${SIZE}" height="${SIZE}" viewBox="${box}">${inner}</svg>`;
    }),
  );
  const count = icons.length + extras.length;
  await writeFile(`assets/${name}.svg`, svgDoc(PAD * 2 + count * SIZE + (count - 1) * GAP, 80, `${name} stack`, [...glyphs, ...nested].join("\n")));
  console.log(`Wrote assets/${name}.svg (${count} icons).`);
};

// shields.io's for-the-badge look, minus shields.io. The link stays in the README markdown,
// so these are still clickable.
const badge = async (name, label, slug, color) => {
  const H = 28, SIZE = 11, CW = 8.4, logo = 15;
  const w = 14 + logo + 8 + label.length * CW + 14;
  await writeFile(
    `assets/badge-${name}.svg`,
    svgDoc(w, H, label, [
      `<rect x="0" y="0" width="${w}" height="${H}" rx="4" fill="${color}"/>`,
      `<path d="${await iconPath(slug)}" fill="#fff" transform="translate(14,${(H - logo) / 2}) scale(${logo / 24})"/>`,
      `<text x="${14 + logo + 8}" y="${H / 2 + 4}" font-family="${FONT}" font-size="${SIZE}" font-weight="700" fill="#fff" letter-spacing="1.5" textLength="${(label.length * CW).toFixed(1)}" lengthAdjust="spacing">${esc(label)}</text>`,
    ].join("\n")),
  );
};

await mkdir("assets", { recursive: true });
await headerCard();
await stackStrip("stack-build", STACK.build);
await stackStrip("stack-ship", STACK.ship, ["assets/comfyui.svg"]);
await Promise.all([
  badge("portfolio", "IAMSAEED.DEV", "googlechrome", "#E2574C"),
  badge("linkedin", "LINKEDIN", "linkedin", "#0A66C2"),
  badge("email", "EMAIL", "gmail", "#EA4335"),
]);
console.log("Wrote assets/badge-*.svg.");

let md = await readFile(FILE, "utf8");
md = replaceRegion(md, "BUILDING", building);
md = replaceRegion(md, "FEATURED", featured);
md = replaceRegion(md, "ACTIVITY", activity);
if (process.env.GITHUB_TOKEN) {
  await statsRegion();
  await streakCard();
} else console.warn("No GITHUB_TOKEN — leaving the stat cards in assets/ unchanged.");
await writeFile(FILE, md);

console.log(`Updated ${FILE}: ${BUILDING} building, ${FEATURED} featured, ${shown.length} activity entries.`);
