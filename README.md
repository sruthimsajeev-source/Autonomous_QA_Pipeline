# Autonomous QA Pipeline (Groq + Playwright)

This project implements a full autonomous QA pipeline with separate agents:

1. Requirement Reader Agent
2. Planner Agent -> converts requirement text to JSON test plan
3. Generator Agent -> creates Playwright `*.spec.ts`
4. Executor Agent -> runs tests with configurable Playwright workers
5. Failure Analyzer Agent -> classifies failures into 7 categories
6. Healer Agent -> heals locator/timing issues and reruns healed tests
7. Quality Gate Agent -> PASS/FAIL based on healing success
8. Reporter Agent -> generates premium HTML report at `reports/autonomous-report.html`

## Setup

```bash
npm install
npx playwright install
```

Create `.env` from `.env.example`:

```bash
GROQ_API_KEY=your_real_key
BASE_URL=http://localhost:3000
PLAYWRIGHT_WORKERS=4
```

## Run

```bash
npm run pipeline -- --requirement=requirements.txt --baseUrl=http://localhost:3000 --workers=4
```

## Outputs

- Generated test plan JSON: `reports/generated-test-plan.json`
- Generated spec: `tests/generated/autonomous.spec.ts`
- Playwright result JSON: `reports/playwright-results.json`
- Premium autonomous report: `reports/autonomous-report.html`
- Live state JSON for dashboard: `reports/pipeline-live.json`

## Standalone Live UI (Next.js + Socket.IO)

The standalone UI lives in `ui` and streams pipeline updates in real time.

```bash
cd ui
npm install
npm run dev
```

Open: `http://localhost:3001`

How it works:
- `ui/server.js` starts Next.js + Socket.IO
- Watches `../reports/pipeline-live.json`
- Pushes `pipeline:update` events to the browser

The UI includes:
- auto-refreshing live pipeline status
- animated agent timeline/progress
- expandable failed-test artifact links (screenshot/video/trace/error-context)

## Notes

- If `GROQ_API_KEY` is not present, planner uses fallback plan.
- Healer only applies safe auto-fixes for locator/timing categories.
- Quality gate returns `PASS` only when healed rerun has zero remaining failures and all healable failures were addressed.
