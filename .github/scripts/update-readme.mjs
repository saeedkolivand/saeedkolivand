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
const card = (title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="170" viewBox="0 0 400 170" role="img" aria-label="${esc(title)}">
<rect x="0" y="0" width="400" height="170" rx="6" fill="${BG}"/>
${text(25, 34, title, { size: 18, weight: 600, fill: TITLE })}
${body}
</svg>
`;

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

let md = await readFile(FILE, "utf8");
md = replaceRegion(md, "BUILDING", building);
md = replaceRegion(md, "FEATURED", featured);
md = replaceRegion(md, "ACTIVITY", activity);
if (process.env.GITHUB_TOKEN) await statsRegion();
else console.warn("No GITHUB_TOKEN — leaving the stat cards in assets/ unchanged.");
await writeFile(FILE, md);

console.log(`Updated ${FILE}: ${BUILDING} building, ${FEATURED} featured, ${shown.length} activity entries.`);
