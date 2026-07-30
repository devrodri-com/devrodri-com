import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const token = process.env.GITHUB_TOKEN;
const username = process.env.GITHUB_USERNAME || "devrodri-com";
const timezone = process.env.PROFILE_TIMEZONE || "America/New_York";
const outputPath = resolve(process.env.OUTPUT_PATH || "assets/github-stats.svg");
const now = process.env.STATS_NOW ? new Date(process.env.STATS_NOW) : new Date();

if (!token) {
  throw new Error("GITHUB_TOKEN is required.");
}

if (Number.isNaN(now.getTime())) {
  throw new Error("STATS_NOW must be a valid ISO date when provided.");
}

const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

const query = `
  query ProfileStats($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      repositories(ownerAffiliations: OWNER, privacy: PUBLIC) {
        totalCount
      }
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          contributions {
            totalCount
          }
          repository {
            isPrivate
          }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          contributions {
            totalCount
          }
          repository {
            isPrivate
          }
        }
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "devrodri-profile-stats",
  },
  body: JSON.stringify({
    query,
    variables: {
      login: username,
      from: from.toISOString(),
      to: now.toISOString(),
    },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(
    `GitHub GraphQL request failed: ${payload.errors
      .map((error) => error.message)
      .join("; ")}`,
  );
}

const user = payload.data?.user;

if (!user) {
  throw new Error(`GitHub user "${username}" was not found.`);
}

const contributions = user.contributionsCollection;
const days = contributions.contributionCalendar.weeks
  .flatMap((week) => week.contributionDays)
  .filter((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    return date >= from && date <= now;
  });

const months = new Map();

for (const day of days) {
  const month = day.date.slice(0, 7);
  months.set(month, (months.get(month) || 0) + day.contributionCount);
}

const monthlyActivity = [...months.entries()].map(([month, total]) => ({
  month,
  total,
}));

if (monthlyActivity.length === 0) {
  const currentMonth = now.toISOString().slice(0, 7);
  monthlyActivity.push({ month: currentMonth, total: 0 });
}

const chart = createChart(monthlyActivity);
const totalContributions =
  contributions.contributionCalendar.totalContributions;
const totalCommits = sumPublicContributions(
  contributions.commitContributionsByRepository,
);
const totalPullRequests = sumPublicContributions(
  contributions.pullRequestContributionsByRepository,
);
const publicRepositories = user.repositories.totalCount;
const updatedAt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: timezone,
  year: "numeric",
}).format(now);

const svg = renderSvg({
  chart,
  publicRepositories,
  totalCommits,
  totalContributions,
  totalPullRequests,
  updatedAt,
  username,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg, "utf8");

console.log(
  `Updated ${outputPath} with ${formatNumber(totalContributions)} contributions through ${updatedAt}.`,
);

function createChart(activity) {
  const left = 52;
  const right = 1148;
  const top = 260;
  const bottom = 356;
  const width = right - left;
  const height = bottom - top;
  const maximum = Math.max(...activity.map(({ total }) => total), 1);
  const denominator = Math.max(activity.length - 1, 1);

  const points = activity.map(({ month, total }, index) => ({
    month,
    total,
    x: round(left + (index / denominator) * width),
    y: round(bottom - (total / maximum) * height),
  }));

  const linePath = points
    .map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
    .join(" ");
  const areaPath = `M ${points[0].x} ${bottom} ${points
    .map(({ x, y }) => `L ${x} ${y}`)
    .join(" ")} L ${points.at(-1).x} ${bottom} Z`;
  const peak = points.reduce((highest, point) =>
    point.total > highest.total ? point : highest,
  );
  const labelIndexes = [
    0,
    Math.round((points.length - 1) * 0.25),
    Math.round((points.length - 1) * 0.5),
    Math.round((points.length - 1) * 0.75),
    points.length - 1,
  ].filter((index, position, indexes) => indexes.indexOf(index) === position);

  return {
    areaPath,
    labels: labelIndexes.map((index) => ({
      anchor:
        index === 0
          ? "start"
          : index === points.length - 1
            ? "end"
            : "middle",
      text: formatMonth(points[index].month),
      x: points[index].x,
    })),
    linePath,
    peak,
  };
}

function renderSvg({
  chart,
  publicRepositories,
  totalCommits,
  totalContributions,
  totalPullRequests,
  updatedAt,
  username: login,
}) {
  const labels = chart.labels
    .map(
      ({ anchor, text, x }) =>
        `    <text x="${x}" y="390" fill="#8b949e" font-size="12" text-anchor="${anchor}">${escapeXml(text)}</text>`,
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420" role="img" aria-labelledby="title description">
  <title id="title">DevRodri GitHub activity</title>
  <desc id="description">GitHub activity during the last twelve months: ${formatNumber(totalContributions)} contributions, ${formatNumber(totalCommits)} public commits, ${formatNumber(totalPullRequests)} public pull requests, and ${formatNumber(publicRepositories)} public repositories. Automatically updated daily.</desc>

  <defs>
    <linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3fb950" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#3fb950" stop-opacity="0.04" />
    </linearGradient>
    <filter id="soft-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <rect x="1" y="1" width="1198" height="418" rx="18" fill="#0d1117" stroke="#30363d" stroke-width="2" />

  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
    <text x="42" y="48" fill="#58a6ff" font-size="24" font-weight="700">${escapeXml(login)}</text>
    <text x="42" y="74" fill="#8b949e" font-size="14">GitHub activity · automatically refreshed</text>
    <text x="1158" y="48" fill="#3fb950" font-size="14" font-weight="600" text-anchor="end">AUTO-UPDATED DAILY</text>
    <text x="1158" y="72" fill="#c9d1d9" font-size="14" text-anchor="end">Updated ${escapeXml(updatedAt)}</text>

    <g>
      <rect x="42" y="98" width="263" height="90" rx="12" fill="#161b22" stroke="#21262d" />
      <circle cx="70" cy="126" r="7" fill="#3fb950" />
      <text x="88" y="134" fill="#f0f6fc" font-size="29" font-weight="700">${formatNumber(totalContributions)}</text>
      <text x="70" y="166" fill="#8b949e" font-size="14">CONTRIBUTIONS</text>
    </g>

    <g>
      <rect x="326" y="98" width="263" height="90" rx="12" fill="#161b22" stroke="#21262d" />
      <circle cx="354" cy="126" r="7" fill="#58a6ff" />
      <text x="372" y="134" fill="#f0f6fc" font-size="29" font-weight="700">${formatNumber(totalCommits)}</text>
      <text x="354" y="166" fill="#8b949e" font-size="14">PUBLIC COMMITS</text>
    </g>

    <g>
      <rect x="610" y="98" width="263" height="90" rx="12" fill="#161b22" stroke="#21262d" />
      <circle cx="638" cy="126" r="7" fill="#a371f7" />
      <text x="656" y="134" fill="#f0f6fc" font-size="29" font-weight="700">${formatNumber(totalPullRequests)}</text>
      <text x="638" y="166" fill="#8b949e" font-size="14">PUBLIC PULL REQUESTS</text>
    </g>

    <g>
      <rect x="894" y="98" width="264" height="90" rx="12" fill="#161b22" stroke="#21262d" />
      <circle cx="922" cy="126" r="7" fill="#f0883e" />
      <text x="940" y="134" fill="#f0f6fc" font-size="29" font-weight="700">${formatNumber(publicRepositories)}</text>
      <text x="922" y="166" fill="#8b949e" font-size="14">PUBLIC REPOSITORIES</text>
    </g>

    <text x="42" y="226" fill="#c9d1d9" font-size="15" font-weight="600">Contribution activity</text>

    <line x1="52" y1="260" x2="1148" y2="260" stroke="#21262d" />
    <line x1="52" y1="308" x2="1148" y2="308" stroke="#21262d" />
    <line x1="52" y1="356" x2="1148" y2="356" stroke="#30363d" />

    <path d="${chart.areaPath}" fill="url(#activity-fill)" />
    <path d="${chart.linePath}" fill="none" stroke="#3fb950" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#soft-glow)" />

    <circle cx="${chart.peak.x}" cy="${chart.peak.y}" r="5" fill="#3fb950" />
    <text x="${chart.peak.x}" y="${Math.max(chart.peak.y - 12, 244)}" fill="#3fb950" font-size="13" font-weight="700" text-anchor="middle">${formatNumber(chart.peak.total)}</text>

${labels}
  </g>
</svg>
`;
}

function formatMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const name = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));

  return `${name} ’${String(year).slice(-2)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function sumPublicContributions(repositories) {
  return repositories
    .filter(({ repository }) => !repository.isPrivate)
    .reduce((total, item) => total + item.contributions.totalCount, 0);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
