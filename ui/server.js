import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import next from "next";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const dev = process.env.NODE_ENV !== "production";
const host = "0.0.0.0";
const port = Number(process.env.PORT || 3001);

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();
const reportPath = path.resolve(projectRoot, "reports/pipeline-live.json");
const requirementsPath = path.resolve(projectRoot, "requirements.txt");
const specPath = path.resolve(projectRoot, "tests/generated/autonomous.spec.ts");

function readLiveState() {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    // Serve generated spec file
    if (req.url === "/api/spec") {
      try {
        const content = fs.readFileSync(specPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // Serve requirements file
    if (req.url === "/api/requirements") {
      try {
        const content = fs.readFileSync(requirementsPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(content);
      } catch {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("");
      }
      return;
    }

    handle(req, res);
  });

  const io = new Server(httpServer, { cors: { origin: "*" } });

  let lastPayload = "";
  let pipelineProcess = null;

  const publish = () => {
    const payload = readLiveState();
    if (!payload) return;
    const text = JSON.stringify(payload);
    if (text === lastPayload) return;
    lastPayload = text;
    io.emit("pipeline:update", payload);
  };

  fs.watchFile(reportPath, { interval: 800 }, publish);

  io.on("connection", (socket) => {
    // Send current state immediately on connect
    const initial = readLiveState();
    if (initial) socket.emit("pipeline:update", initial);

    // Send pipeline running status
    socket.emit("pipeline:status", { running: pipelineProcess !== null });

    socket.on("pipeline:run", ({ requirements, baseUrl }) => {
      if (pipelineProcess) {
        socket.emit("pipeline:error", "Pipeline is already running.");
        return;
      }

      // Write updated requirements
      try {
        fs.writeFileSync(requirementsPath, requirements, "utf8");
      } catch (err) {
        socket.emit("pipeline:error", `Failed to write requirements: ${err.message}`);
        return;
      }

      const args = ["--loader", "ts-node/esm", "src/index.ts", "run"];
      if (baseUrl) args.push(`--baseUrl=${baseUrl}`);

      pipelineProcess = spawn("node", args, {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: "pipe",
        shell: false
      });

      io.emit("pipeline:status", { running: true });
      socket.emit("pipeline:started");

      pipelineProcess.on("exit", () => {
        pipelineProcess = null;
        publish();
        io.emit("pipeline:status", { running: false });
      });

      pipelineProcess.on("error", (err) => {
        pipelineProcess = null;
        io.emit("pipeline:status", { running: false });
        socket.emit("pipeline:error", err.message);
      });
    });

    socket.on("pipeline:stop", () => {
      if (pipelineProcess) {
        pipelineProcess.kill();
        pipelineProcess = null;
        io.emit("pipeline:status", { running: false });
      }
    });
  });

  httpServer.listen(port, host, () => {
    console.log(`UI server running at http://localhost:${port}`);
  });
});
