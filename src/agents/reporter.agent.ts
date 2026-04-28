import { PipelineResult } from "../types.js";
import { writeText } from "../utils/fs.js";

export class ReporterAgent {
  async generate(result: Omit<PipelineResult, "reportPath">, outputPath: string): Promise<string> {
    const orderedAgents = [
      "Requirement Reader",
      "Planner",
      "Generator",
      "Executor",
      "Failure Analyzer",
      "Healer",
      "Executor Rerun",
      "Quality Gate"
    ];
    const failedAgent = result.agentRuns.find((run) => run.status === "failed");
    const completedCount = orderedAgents.filter((name) =>
      result.agentRuns.some((r) => r.agent === name && r.status !== "skipped")
    ).length;
    const progressPct = Math.round((completedCount / orderedAgents.length) * 100);
    const pipelineCards = result.agentRuns
      .map((run) => {
        const badgeClass =
          run.status === "success" ? "ok" : run.status === "failed" ? "bad" : "skip";
        const width = run.status === "success" ? 100 : run.status === "failed" ? 100 : 0;
        return `<article class="agent-card">
  <div class="agent-head">
    <h3>${escapeHtml(run.agent)}</h3>
    <span class="badge ${badgeClass}">${run.status.toUpperCase()}</span>
  </div>
  <div class="track"><div class="fill ${badgeClass}" style="width:${width}%"></div></div>
  <p class="reason">${escapeHtml(run.reason)}</p>
  <p class="meta">${run.durationMs} ms</p>
</article>`;
      })
      .join("\n");

    const rows = result.analyses
      .map(
        (a) => `<tr class="fail-row">
  <td>${escapeHtml(a.test.title)}</td>
  <td>${a.category}</td>
  <td>${Math.round(a.confidence * 100)}%</td>
  <td>
    <details>
      <summary>${escapeHtml(a.reasoning)}</summary>
      <p><strong>Error:</strong> ${escapeHtml(a.test.errorMessage)}</p>
      <p><strong>File:</strong> ${escapeHtml(a.test.file)}${a.test.line ? `:${a.test.line}` : ""}</p>
      ${
        a.test.attachments && a.test.attachments.length > 0
          ? `<div class="artifacts">${a.test.attachments
              .map(
                (att) =>
                  `<a href="${toFileUrl(att.path)}" target="_blank" rel="noopener noreferrer">${escapeHtml(att.name)}</a>`
              )
              .join("")}</div>`
          : "<p>No artifacts available.</p>"
      }
    </details>
  </td>
</tr>`
      )
      .join("\n");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${result.pipelineState === "RUNNING" ? '<meta http-equiv="refresh" content="3">' : ""}
  <title>Autonomous QA Report</title>
  <style>
    :root {
      --bg: #060b17;
      --card: #0f1730;
      --muted: #9db1ea;
      --line: #27396e;
      --ok: #4de2b0;
      --bad: #ff6a85;
      --skip: #f3c66a;
    }
    * { box-sizing: border-box; }
    body {
      font-family: Inter, Segoe UI, Arial, sans-serif;
      margin: 0;
      color: #eaf1ff;
      background: radial-gradient(1200px 600px at 10% -10%, #1f2a54 0%, var(--bg) 55%);
      min-height: 100vh;
    }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 2rem 1rem 3rem; }
    .hero {
      padding: 1.2rem;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, #111b39, #0e1732);
      margin-bottom: 1rem;
    }
    .hero h1 { margin: 0 0 .5rem; font-size: 1.7rem; }
    .hero p { margin: 0; color: var(--muted); }
    .pill { padding: .24rem .65rem; border-radius: 999px; font-weight: 700; display: inline-block; }
    .pass { background: rgba(77, 226, 176, .15); color: var(--ok); }
    .fail { background: rgba(255, 106, 133, .14); color: var(--bad); }
    .running { background: rgba(243, 198, 106, .15); color: var(--skip); }
    .main-track { background: #17264f; border: 1px solid #2a3f77; border-radius: 999px; height: 14px; overflow: hidden; margin-top: .75rem; }
    .main-fill { height: 100%; background: linear-gradient(90deg, #4de2b0, #7fa4ff); width: ${progressPct}%; transition: width .4s ease; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .metric { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: .9rem; }
    .metric .k { color: var(--muted); font-size: .9rem; }
    .metric .v { font-size: 1.45rem; font-weight: 700; margin-top: .2rem; }
    .panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1rem; margin-top: 1rem; }
    .agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: .8rem; }
    .agent-card { background: #101b38; border: 1px solid #2a3f77; border-radius: 12px; padding: .85rem; }
    .agent-head { display: flex; justify-content: space-between; gap: .5rem; align-items: center; }
    .agent-head h3 { margin: 0; font-size: 1rem; }
    .track { margin-top: .6rem; background: #17264f; border-radius: 999px; height: 8px; overflow: hidden; border: 1px solid #29407a; }
    .fill { height: 100%; transition: width .4s ease; }
    .fill.ok { background: linear-gradient(90deg, #2fc995, #4de2b0); }
    .fill.bad { background: linear-gradient(90deg, #e24c6e, #ff6a85); }
    .fill.skip { background: linear-gradient(90deg, #9c8d5f, #f3c66a); }
    .badge { font-size: .72rem; font-weight: 700; padding: .2rem .45rem; border-radius: 999px; }
    .badge.ok { color: var(--ok); background: rgba(77, 226, 176, .15); }
    .badge.bad { color: var(--bad); background: rgba(255, 106, 133, .14); }
    .badge.skip { color: var(--skip); background: rgba(243, 198, 106, .15); }
    .reason { margin: .6rem 0 .3rem; color: #dbe6ff; min-height: 2.2rem; }
    .meta { color: var(--muted); margin: 0; font-size: .86rem; }
    table { width: 100%; border-collapse: collapse; margin-top: .4rem; }
    th, td { text-align: left; border-bottom: 1px solid #2a3f77; padding: .6rem; vertical-align: top; }
    th { color: #a8bcff; font-weight: 600; }
    details { cursor: pointer; }
    summary { color: #c9d9ff; }
    .artifacts { display: flex; gap: .45rem; flex-wrap: wrap; margin-top: .4rem; }
    .artifacts a {
      border: 1px solid #355094;
      border-radius: 999px;
      text-decoration: none;
      color: #d6e3ff;
      padding: .18rem .55rem;
      font-size: .82rem;
    }
    .failed-box { border: 1px solid #6f2b3b; background: rgba(255, 106, 133, .08); border-radius: 12px; padding: .8rem; }
    .failed-box h3 { margin: 0 0 .35rem; color: #ff9cb2; }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>Autonomous QA Pipeline</h1>
      <p>Track every agent, identify exact failure points, and understand healing impact instantly.</p>
      <p style="margin-top:.7rem;">Build verdict:
        <span class="pill ${
          result.pipelineState === "RUNNING" ? "running" : result.overallStatus === "PASS" ? "pass" : "fail"
        }">${result.pipelineState === "RUNNING" ? "RUNNING" : result.overallStatus}</span>
      </p>
      <div class="main-track"><div class="main-fill"></div></div>
      <p style="margin-top:.5rem;">Pipeline progress: ${progressPct}% (${completedCount}/${orderedAgents.length} agents)</p>
    </section>

    <section class="grid">
      <div class="metric"><div class="k">Total Tests</div><div class="v">${result.totalTests}</div></div>
      <div class="metric"><div class="k">Failed Before Healing</div><div class="v">${result.failedBeforeHealing}</div></div>
      <div class="metric"><div class="k">Failed After Healing</div><div class="v">${result.failedAfterHealing}</div></div>
      <div class="metric"><div class="k">Generated Spec</div><div class="v" style="font-size:.92rem;">${escapeHtml(result.generatedSpecPath)}</div></div>
    </section>

    <section class="panel">
      <h2>Agent Pipeline Status</h2>
      <div class="agents">
        ${
          pipelineCards ||
          orderedAgents
            .map(
              (name) => `<article class="agent-card">
  <div class="agent-head"><h3>${name}</h3><span class="badge skip">PENDING</span></div>
  <div class="track"><div class="fill skip" style="width:0%"></div></div>
  <p class="reason">Waiting to start</p><p class="meta">0 ms</p>
</article>`
            )
            .join("")
        }
      </div>
    </section>

    ${
      failedAgent
        ? `<section class="panel failed-box">
      <h3>Failed Agent: ${escapeHtml(failedAgent.agent)}</h3>
      <p>${escapeHtml(failedAgent.reason)}</p>
    </section>`
        : ""
    }

    <section class="panel">
    <h2>Failure Analysis Details</h2>
    <table>
      <thead>
        <tr><th>Test</th><th>Category</th><th>Confidence</th><th>Reason</th></tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='4'>No failures found.</td></tr>"}
      </tbody>
    </table>
    </section>
  </div>
</body>
</html>`;

    await writeText(outputPath, html);
    return outputPath;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `file:///${encoded}`;
}
