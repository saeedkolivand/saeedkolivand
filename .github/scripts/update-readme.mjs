// Regenerates the marker-delimited regions of README.md from the GitHub API.
// No dependencies: Node's built-in fetch. Run it locally with `node .github/scripts/update-readme.mjs`.
import { readFile, writeFile } from "node:fs/promises";

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

let md = await readFile(FILE, "utf8");
md = replaceRegion(md, "BUILDING", building);
md = replaceRegion(md, "FEATURED", featured);
md = replaceRegion(md, "ACTIVITY", activity);
await writeFile(FILE, md);

console.log(`Updated ${FILE}: ${BUILDING} building, ${FEATURED} featured, ${shown.length} activity entries.`);
