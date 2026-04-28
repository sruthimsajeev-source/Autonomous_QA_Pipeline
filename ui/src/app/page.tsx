"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

// ─── Types ─────────────────────────────────────────────────────────────────────

type AgentStatus = "success" | "failed" | "skipped" | "pending" | "running";

interface LocatorStrategy {
  strategy: string;
  role?: string; name?: string; label?: string;
  testId?: string; text?: string; placeholder?: string; selector?: string;
}
interface TestStep {
  type: string; selector: string; value?: string;
  description: string; resolvedLocator?: LocatorStrategy;
}
interface TestValidation {
  type: string; target: string; expected: string;
  description: string; resolvedLocator?: LocatorStrategy;
}
interface TestCase {
  id: string; title: string;
  steps: TestStep[]; validations: TestValidation[];
}
interface TestPlan { source: string; createdAt: string; cases: TestCase[]; }
interface TestResult {
  title: string; status: "passed" | "failed" | "timedOut" | "skipped";
  durationMs: number; errorMessage?: string;
}
interface FailureAnalysis {
  category: string; confidence: number; reasoning: string;
  test: { title: string; errorMessage: string };
}
interface PipelineState {
  pipelineState: "RUNNING" | "COMPLETED";
  overallStatus: "PASS" | "FAIL";
  totalTests: number;
  failedBeforeHealing: number;
  failedAfterHealing: number;
  generatedSpecPath: string;
  testPlan?: TestPlan;
  testResults?: TestResult[];
  analyses: FailureAnalysis[];
  healing: { healed: boolean; reason: string; healedTestTitles: string[] };
  agentRuns: Array<{ agent: string; status: AgentStatus; reason: string; durationMs: number; logs: string[] }>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const AGENTS = [
  { key: "Requirement Reader", icon: "📋", label: "Reader"    },
  { key: "Planner",            icon: "🧠", label: "Planner"   },
  { key: "DOM Crawler",        icon: "🕷️",  label: "Crawler"   },
  { key: "Generator",          icon: "⚙️",  label: "Generator" },
  { key: "Executor",           icon: "▶️",  label: "Executor"  },
  { key: "Failure Analyzer",   icon: "🔍", label: "Analyzer"  },
  { key: "Healer",             icon: "🩹", label: "Healer"    },
  { key: "Executor Rerun",     icon: "🔄", label: "Rerun"     },
  { key: "Quality Gate",       icon: "🏁", label: "Gate"      },
];

const CAT_CLASS: Record<string, string> = {
  POSITIVE: "cat-positive", NEGATIVE: "cat-negative",
  BOUNDARY: "cat-boundary", EDGE: "cat-edge",
};

const TABS = ["Test Cases", "Script", "Execution", "Analysis", "Quality Gate"] as const;
type Tab = typeof TABS[number];

const TAB_ICON: Record<Tab, string> = {
  "Test Cases":   "🧪",
  "Script":       "📝",
  "Execution":    "▶️",
  "Analysis":     "🔍",
  "Quality Gate": "🏁",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function extractCat(title: string) {
  const m = /^\[(POSITIVE|NEGATIVE|BOUNDARY|EDGE)\]/.exec(title);
  return m ? m[1] : "POSITIVE";
}

function locStr(loc: LocatorStrategy): string {
  switch (loc.strategy) {
    case "getByRole":        return `role=${loc.role}[name="${loc.name}"]`;
    case "getByLabel":       return `label="${loc.label}"`;
    case "getByTestId":      return `testId="${loc.testId}"`;
    case "getByText":        return `text="${loc.text}"`;
    case "getByPlaceholder": return `placeholder="${loc.placeholder}"`;
    case "locator":          return loc.selector ?? "";
    default: return JSON.stringify(loc);
  }
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function highlightTS(code: string): string {
  return code.split("\n").map(line => {
    let s = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (/^\s*\/\//.test(s)) return `<span class="hl-comment">${s}</span>`;
    s = s.replace(/("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, '<span class="hl-string">$1</span>');
    s = s.replace(/\b(import|from|const|let|var|async|await|return|type|interface|export|true|false|null|undefined)\b/g, '<span class="hl-kw">$1</span>');
    s = s.replace(/\b(test\.describe|test|expect|page|beforeEach|afterEach)\b/g, '<span class="hl-pw">$1</span>');
    s = s.replace(/\.([a-zA-Z]+)(?=\s*\()/g, '.<span class="hl-fn">$1</span>');
    return s;
  }).join("\n");
}

function stepTypeClass(type: string): string {
  const map: Record<string, string> = {
    navigate: "stype-navigate", click: "stype-click", type: "stype-type",
    select: "stype-select", assert: "stype-assert", assert_url: "stype-url",
    assert_heading: "stype-heading", assert_text: "stype-text", assert_visible: "stype-visible",
  };
  return map[type] ?? "stype-assert";
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function Home() {
  const [state,       setState]      = useState<PipelineState | null>(null);
  const [connected,   setConnected]  = useState(false);
  const [running,     setRunning]    = useState(false);
  const [activeTab,   setActiveTab]  = useState<Tab>("Test Cases");
  const [requirements,setRequirements] = useState("");
  const [baseUrl,     setBaseUrl]    = useState("https://automationexercise.com");
  const [specContent, setSpecContent] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    fetch("/api/requirements").then(r => r.text()).then(t => { if (t.trim()) setRequirements(t); }).catch(() => {});
  }, []);

  useEffect(() => {
    const socket: Socket = io({ transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect",          () => setConnected(true));
    socket.on("disconnect",       () => setConnected(false));
    socket.on("pipeline:update",  (p: PipelineState) => setState(p));
    socket.on("pipeline:status",  ({ running: r }: { running: boolean }) => setRunning(r));
    socket.on("pipeline:started", () => setRunning(true));
    socket.on("pipeline:error",   (msg: string) => { alert(`Pipeline error: ${msg}`); setRunning(false); });
    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    if (state?.agentRuns.some(r => r.agent === "Generator" && r.status === "success") && !specContent) {
      fetch("/api/spec").then(r => r.text()).then(setSpecContent).catch(() => {});
    }
  }, [state, specContent]);

  useEffect(() => {
    if (state?.pipelineState === "COMPLETED") {
      setRunning(false);
      fetch("/api/spec").then(r => r.text()).then(setSpecContent).catch(() => {});
    }
  }, [state?.pipelineState]);

  const handleRun = useCallback(() => {
    if (running || !socketRef.current) return;
    setSpecContent(null);
    setState(null);
    socketRef.current.emit("pipeline:run", { requirements, baseUrl });
  }, [running, requirements, baseUrl]);

  const completedCount = state
    ? AGENTS.filter(a => state.agentRuns.some(r => r.agent === a.key)).length
    : 0;
  const progress = Math.round((completedCount / AGENTS.length) * 100);
  const isDone  = state?.pipelineState === "COMPLETED";
  const isPass  = state?.overallStatus === "PASS";

  return (
    <main className="page">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-brand">
          <span className="header-logo">🤖</span>
          <div>
            <div className="header-title">Autonomous QA Pipeline</div>
            <div className="header-subtitle">AI-powered end-to-end test generation &amp; execution</div>
          </div>
        </div>
        <div className="header-right">
          <span className={`pill ${connected ? "pill-live" : "pill-off"}`}>
            <span className="pill-dot" />
            {connected ? "LIVE" : "OFFLINE"}
          </span>
          {isDone && (
            <span className={`pill ${isPass ? "pill-pass" : "pill-fail"}`}>
              {isPass ? "✅ GO" : "❌ NO-GO"}
            </span>
          )}
          {running && <span className="pill pill-running">⚙ RUNNING</span>}
        </div>
      </header>

      {/* ── Pipeline Panel (progress + agent cards in one card) ─────────────── */}
      <div className="pipeline-panel">
        <div className="pipeline-panel-header">
          <div className="pipeline-panel-title">
            <span className="pipeline-panel-icon">⚡</span>
            Pipeline Flow
          </div>
          <div className="pipeline-panel-meta">
            <div className="progress-bar-inline">
              <div className="progress-fill-inline" style={{ width: `${progress}%` }} />
            </div>
            <span className="pipeline-panel-count">
              {completedCount} / {AGENTS.length} agents
            </span>
            {running && <span className="pipeline-running-dot" />}
          </div>
        </div>

        <div className="pipeline-flow">
          {AGENTS.map((agent, idx) => {
            const run    = state?.agentRuns.find(r => r.agent === agent.key);
            const status: AgentStatus = running && !run && idx === completedCount
              ? "running"
              : run?.status ?? "pending";
            const isConnDone = run?.status === "success" || run?.status === "skipped";

            return (
              <div key={agent.key} style={{ display: "flex", alignItems: "center" }}>
                <div className={`agent-node ${status}`}>
                  <span className="agent-num">{idx + 1}</span>
                  <div className="agent-icon-ring">{agent.icon}</div>
                  <span className="agent-name">{agent.label}</span>
                  <span className={`agent-status-badge asbadge-${status}`}>
                    {status === "success" ? "✓ done"
                     : status === "failed"  ? "✗ failed"
                     : status === "skipped" ? "↷ skipped"
                     : status === "running" ? "● running"
                     : "pending"}
                  </span>
                  {run?.durationMs != null && run.durationMs > 0 && (
                    <span className="agent-dur">{fmt(run.durationMs)}</span>
                  )}
                </div>
                {idx < AGENTS.length - 1 && (
                  <div className={`agent-connector ${isConnDone ? "done" : ""}`}>
                    <span className="connector-arrow">›</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Body Grid ───────────────────────────────────────────────────────── */}
      <div className="body-grid">

        {/* Left: Requirements */}
        <aside>
          <div className="panel">
            <div className="panel-title">📋 Requirements</div>
            <div className="req-form">
              <div>
                <label className="field-label">Test Requirements</label>
                <textarea
                  className="req-textarea"
                  value={requirements}
                  onChange={e => setRequirements(e.target.value)}
                  placeholder={"Paste your test requirements here…\n\nExample:\n1. Navigate to the app\n2. Click Login\n3. Enter credentials\n4. Verify redirect"}
                  rows={9}
                  disabled={running}
                />
              </div>
              <div>
                <label className="field-label">Base URL</label>
                <input
                  className="url-input"
                  type="text"
                  value={baseUrl}
                  onChange={e => setBaseUrl(e.target.value)}
                  placeholder="https://your-app.com"
                  disabled={running}
                />
              </div>
              <button
                className={`run-btn ${running ? "run-btn-disabled" : ""}`}
                onClick={handleRun}
                disabled={running}
              >
                {running ? "⚙  Pipeline Running…" : "▶  Run Pipeline"}
              </button>
            </div>
          </div>
        </aside>

        {/* Right: Tabbed panels */}
        <div className="main-col">
          <div className="tab-bar">
            {TABS.map(tab => (
              <button
                key={tab}
                className={`tab-btn ${activeTab === tab ? "tab-active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                <span className="tab-icon">{TAB_ICON[tab]}</span>
                {tab}
              </button>
            ))}
          </div>

          <div className="tab-content">
            {activeTab === "Test Cases" && (
              <TestCasesPanel testPlan={state?.testPlan} testResults={state?.testResults} />
            )}
            {activeTab === "Script" && (
              <ScriptPanel specContent={specContent} />
            )}
            {activeTab === "Execution" && (
              <ExecutionPanel
                results={state?.testResults}
                totalTests={state?.totalTests ?? 0}
                failedBefore={state?.failedBeforeHealing ?? 0}
                failedAfter={state?.failedAfterHealing ?? 0}
              />
            )}
            {activeTab === "Analysis" && (
              <AnalysisPanel analyses={state?.analyses ?? []} healing={state?.healing} />
            )}
            {activeTab === "Quality Gate" && (
              <QualityGatePanel state={state} isDone={isDone} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Test Cases Panel ───────────────────────────────────────────────────────────

function TestCasesPanel({ testPlan, testResults }: { testPlan?: TestPlan; testResults?: TestResult[] }) {
  if (!testPlan) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🧠</div>
        <div className="empty-title">No test cases yet</div>
        <div className="empty-desc">Test cases will appear here once the Planner agent generates them. Run the pipeline to get started.</div>
      </div>
    );
  }

  const grouped: Record<string, TestCase[]> = {};
  for (const tc of testPlan.cases) {
    const cat = extractCat(tc.title);
    (grouped[cat] ??= []).push(tc);
  }
  const catOrder = ["POSITIVE", "NEGATIVE", "BOUNDARY", "EDGE"];
  const resultMap = new Map(testResults?.map(r => [r.title, r]) ?? []);

  function findResult(tc: TestCase): TestResult | undefined {
    return resultMap.get(tc.title)
      ?? testResults?.find(r => r.title === tc.title)
      ?? testResults?.find(r => r.title.includes(tc.title.replace(/^\[.*?\]\s*/, ""))
          || tc.title.includes(r.title));
  }

  return (
    <div className="test-cases">
      <div className="tc-summary-bar">
        <span className="tc-total-label">{testPlan.cases.length} Test Cases</span>
        {catOrder.filter(c => grouped[c]).map(cat => (
          <span key={cat} className={`cat-pill-count ${CAT_CLASS[cat]}`}>
            {grouped[cat].length} {cat}
          </span>
        ))}
      </div>

      {catOrder.filter(c => grouped[c]).map(cat => (
        <div key={cat} className="tc-group">
          <div className={`tc-group-header ${CAT_CLASS[cat]}`}>
            <span className="tc-group-title">{cat}</span>
            <span className="tc-group-count">{grouped[cat].length} test{grouped[cat].length !== 1 ? "s" : ""}</span>
          </div>
          <div className="tc-list">
            {grouped[cat].map(tc => (
              <TestCaseCard key={tc.id} tc={tc} result={findResult(tc)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TestCaseCard({ tc, result }: { tc: TestCase; result?: TestResult }) {
  const [open, setOpen] = useState(false);
  const cat = extractCat(tc.title);
  const titleClean = tc.title.replace(/^\[.*?\]\s*/, "");

  const resolvedSteps = tc.steps.filter(s => s.resolvedLocator && s.type !== "navigate").length;
  const totalSteps    = tc.steps.filter(s => s.type !== "navigate").length;

  const resultClass = result
    ? (result.status === "passed" ? "tc-pass" : "tc-fail")
    : "";

  const badgeClass = result
    ? (result.status === "passed" ? "badge-pass"
       : result.status === "timedOut" ? "badge-timeout"
       : "badge-fail")
    : "";

  const badgeLabel = result
    ? (result.status === "passed" ? "✓ PASS"
       : result.status === "timedOut" ? "⏱ TIMEOUT"
       : "✗ FAIL")
    : "";

  return (
    <article className={`tc-card ${resultClass}`}>
      <div className="tc-head" onClick={() => setOpen(o => !o)}>
        <div className="tc-head-left">
          <span className={`cat-chip ${CAT_CLASS[cat]}`}>{cat}</span>
          <span className="tc-id">{tc.id}</span>
          <span className="tc-title">{titleClean}</span>
        </div>
        <div className="tc-head-right">
          {result && (
            <span className={`result-badge ${badgeClass}`}>
              {badgeLabel}
              {result.durationMs > 0 && ` · ${fmt(result.durationMs)}`}
            </span>
          )}
          {totalSteps > 0 && (
            <span className={`loc-badge ${resolvedSteps === totalSteps ? "loc-full" : "loc-partial"}`}>
              🎯 {resolvedSteps}/{totalSteps}
            </span>
          )}
          <span className={`tc-toggle ${open ? "open" : ""}`}>▼</span>
        </div>
      </div>

      {open && (
        <div className="tc-body">
          <div>
            <div className="tc-section-title">Steps</div>
            <div className="step-rows">
              {tc.steps.map((step, i) => (
                <div key={i} className="step-row">
                  <span className={`step-type-chip ${stepTypeClass(step.type)}`}>
                    {step.type.replace("assert_", "").toUpperCase()}
                  </span>
                  <span className="step-desc">{step.description}</span>
                  {step.value && <span className="step-value">"{step.value}"</span>}
                  {step.resolvedLocator && (
                    <span className="loc-tag loc-resolved">🎯 {locStr(step.resolvedLocator)}</span>
                  )}
                  {!step.resolvedLocator && step.type !== "navigate" && (
                    <span className="loc-tag loc-fallback">⚠ {step.selector}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {tc.validations.length > 0 && (
            <div>
              <div className="tc-section-title">Assertions</div>
              <div className="step-rows">
                {tc.validations.map((v, i) => (
                  <div key={i} className="step-row">
                    <span className={`step-type-chip ${stepTypeClass(v.type)}`}>
                      {v.type.replace("assert_", "").toUpperCase()}
                    </span>
                    <span className="step-desc">{v.description}</span>
                    <span className="step-value">"{v.expected}"</span>
                    {v.resolvedLocator && (
                      <span className="loc-tag loc-resolved">🎯 {locStr(v.resolvedLocator)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result?.errorMessage && (
            <div className="error-block">
              <div className="tc-section-title" style={{ marginBottom: "0.5rem" }}>Error</div>
              <pre className="error-pre">{result.errorMessage.slice(0, 500)}</pre>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Script Panel ───────────────────────────────────────────────────────────────

function ScriptPanel({ specContent }: { specContent: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!specContent) {
    return (
      <div className="empty-state">
        <div className="empty-icon">⚙️</div>
        <div className="empty-title">Script not generated yet</div>
        <div className="empty-desc">The generated Playwright TypeScript script will appear here once the Generator agent completes.</div>
      </div>
    );
  }

  const copy = () => {
    navigator.clipboard.writeText(specContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const lines = specContent.split("\n");

  return (
    <div className="script-panel">
      <div className="script-toolbar">
        <span className="script-filename">autonomous.spec.ts</span>
        <div className="script-meta">
          <span className="script-lines">{lines.length} lines</span>
          <button className="copy-btn" onClick={copy}>
            {copied ? "✓ Copied!" : "📋 Copy"}
          </button>
        </div>
      </div>
      <div className="code-outer">
        <div className="line-nums">
          {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
        </div>
        <pre className="code-block" dangerouslySetInnerHTML={{ __html: highlightTS(specContent) }} />
      </div>
    </div>
  );
}

// ─── Execution Panel ────────────────────────────────────────────────────────────

function ExecutionPanel({ results, totalTests, failedBefore, failedAfter }: {
  results?: TestResult[];
  totalTests: number;
  failedBefore: number;
  failedAfter: number;
}) {
  if (!results || results.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">▶️</div>
        <div className="empty-title">No results yet</div>
        <div className="empty-desc">Test execution results will appear here once the Executor agent runs the Playwright suite.</div>
      </div>
    );
  }

  const passed  = results.filter(r => r.status === "passed").length;
  const failed  = results.filter(r => r.status !== "passed" && r.status !== "skipped").length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  return (
    <div className="exec-panel">
      <div className="exec-stats">
        <div className="exec-stat exec-stat-pass">
          <span className="es-num">{passed}</span>
          <span className="es-label">Passed</span>
        </div>
        <div className="exec-stat exec-stat-fail">
          <span className="es-num">{failed}</span>
          <span className="es-label">Failed</span>
        </div>
        <div className="exec-stat">
          <span className="es-num">{totalTests || results.length}</span>
          <span className="es-label">Total</span>
        </div>
        <div className="exec-stat">
          <span className="es-num">{fmt(totalMs)}</span>
          <span className="es-label">Duration</span>
        </div>
      </div>

      <table className="results-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Test Name</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i}>
              <td className="row-idx">{i + 1}</td>
              <td className="row-title">
                {r.title}
                {r.errorMessage && (
                  <details className="err-details">
                    <summary>View error</summary>
                    <pre>{r.errorMessage.slice(0, 300)}</pre>
                  </details>
                )}
              </td>
              <td>
                <span className={`result-badge ${r.status === "passed" ? "badge-pass" : r.status === "timedOut" ? "badge-timeout" : "badge-fail"}`}>
                  {r.status === "passed" ? "✓ PASS" : r.status === "timedOut" ? "⏱ TIMEOUT" : "✗ FAIL"}
                </span>
              </td>
              <td className="row-dur">{fmt(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {failedBefore > 0 && failedAfter < failedBefore && (
        <div className="heal-note">
          🩹 Healer fixed {failedBefore - failedAfter} of {failedBefore} failing tests.
          {failedAfter === 0 ? " All tests now pass." : ` ${failedAfter} still failing after healing.`}
        </div>
      )}
    </div>
  );
}

// ─── Analysis Panel ─────────────────────────────────────────────────────────────

function AnalysisPanel({
  analyses, healing,
}: {
  analyses: FailureAnalysis[];
  healing?: { healed: boolean; reason: string; healedTestTitles: string[] };
}) {
  if (analyses.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🔍</div>
        <div className="empty-title">
          {healing ? "No failures detected" : "Analysis pending"}
        </div>
        <div className="empty-desc">
          {healing
            ? "All tests passed — the pipeline ran cleanly with no failures to analyze."
            : "Failure analysis will appear here if any tests fail during execution."}
        </div>
      </div>
    );
  }

  return (
    <div className="analysis-panel">
      {healing?.healed && (
        <div className="heal-banner">
          🩹 Healer fixed {healing.healedTestTitles.length} test{healing.healedTestTitles.length !== 1 ? "s" : ""}:
          {" "}{healing.healedTestTitles.join(", ")}
        </div>
      )}
      {analyses.map((a, i) => (
        <div key={i} className="analysis-card">
          <div className="ac-head">
            <span className="ac-title">{a.test.title}</span>
            <span className={`ac-badge ac-${a.category}`}>{a.category.replace(/_/g, " ")}</span>
            <span className="ac-conf">{Math.round(a.confidence * 100)}% confidence</span>
          </div>
          <p className="ac-reason">{a.reasoning}</p>
          <details className="ac-err">
            <summary>View error details</summary>
            <pre>{a.test.errorMessage.slice(0, 500)}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}

// ─── Quality Gate Panel ─────────────────────────────────────────────────────────

function QualityGatePanel({ state, isDone }: { state: PipelineState | null; isDone: boolean }) {
  if (!isDone || !state) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🏁</div>
        <div className="empty-title">Awaiting verdict</div>
        <div className="empty-desc">The Quality Gate will deliver its GO / NO-GO verdict once the full pipeline completes.</div>
      </div>
    );
  }

  const isPass = state.overallStatus === "PASS";
  const passRate = state.totalTests > 0
    ? Math.round(((state.totalTests - state.failedAfterHealing) / state.totalTests) * 100)
    : 0;

  return (
    <div className="gate-panel">
      <div className={`gate-verdict ${isPass ? "gate-go" : "gate-nogo"}`}>
        <div className="gate-emoji">{isPass ? "✅" : "❌"}</div>
        <div className="gate-label">{isPass ? "GO" : "NO-GO"}</div>
        <div className="gate-sub">
          {isPass ? "Pipeline passed all quality thresholds" : "Pipeline failed quality thresholds"}
        </div>
      </div>

      <div className="gate-metrics">
        <GateMetric label="Total Tests"          value={state.totalTests} />
        <GateMetric label="Passed"               value={state.totalTests - state.failedAfterHealing} color="green" />
        <GateMetric label="Failed (before heal)" value={state.failedBeforeHealing} color={state.failedBeforeHealing > 0 ? "red" : "green"} />
        <GateMetric label="Failed (after heal)"  value={state.failedAfterHealing}  color={state.failedAfterHealing  > 0 ? "red" : "green"} />
        <GateMetric label="Tests Healed"         value={state.healing.healedTestTitles.length} color="blue" />
        <GateMetric label="Pass Rate"            value={`${passRate}%`} color={passRate === 100 ? "green" : passRate >= 80 ? "yellow" : "red"} />
      </div>

      {(state.analyses.length > 0 || state.healing.healed) && (
        <div className="gate-extras">
          {state.analyses.length > 0 && (
            <div className="gate-card">
              <h3>Failure Breakdown</h3>
              {Object.entries(
                state.analyses.reduce<Record<string, number>>((acc, a) => {
                  acc[a.category] = (acc[a.category] ?? 0) + 1; return acc;
                }, {})
              ).map(([cat, count]) => (
                <div key={cat} className="gate-cat-row">
                  <span className={`ac-badge ac-${cat}`}>{cat.replace(/_/g, " ")}</span>
                  <span>{count} test{count > 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          )}
          {state.healing.healed && (
            <div className="gate-card">
              <h3>Healing Applied</h3>
              <p>{state.healing.reason}</p>
              {state.healing.healedTestTitles.length > 0 && (
                <ul>
                  {state.healing.healedTestTitles.map(t => <li key={t}>{t}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GateMetric({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className={`gate-metric gm-${color ?? "default"}`}>
      <span className="gm-val">{value}</span>
      <span className="gm-label">{label}</span>
    </div>
  );
}
