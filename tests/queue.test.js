import io from "socket.io-client";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma.js";

const BASE_URL = "http://localhost:3000/api/v1";
const SOCKET_URL = "http://localhost:3000";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

function assert(label, condition, details = "") {
  if (condition) {
    log(`  ✅ PASS: ${label}`, "green");
    passed++;
  } else {
    log(`  ❌ FAIL: ${label}`, "red");
    if (details) log(`     → ${details}`, "yellow");
    failed++;
  }
}

async function request(method, path, body = null) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-bypass": "supersecretbypass",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - BACKGROUND QUEUE & WEBSOCKET INTEGRATION TEST", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // 1. Create a test company
  log("⚙️ Creating test company...", "cyan");
  const companyUsername = `ws_co_${Date.now()}`;
  const companyEmail = `ws_co_${Date.now()}@example.com`;
  const companyRes = await request("POST", "/companies", {
    name: "WebSocket Test Company",
    username: companyUsername,
    password: "password123",
    email: companyEmail,
  });

  if (companyRes.status !== 201 || !companyRes.data?.data?.company?.id) {
    log("  ❌ Failed to create test company. Exiting.", "red");
    process.exit(1);
  }
  const companyId = companyRes.data.data.company.id;
  log(`  Test Company ID: ${companyId}`, "green");

  // 2. Connect to Socket.io server
  log("🔌 Connecting to Socket.io server...", "cyan");
  const socket = io(SOCKET_URL);

  const socketConnected = await new Promise((resolve) => {
    socket.on("connect", () => resolve(true));
    setTimeout(() => resolve(false), 5000);
  });

  assert("Socket.io connected successfully", socketConnected);
  if (!socketConnected) {
    process.exit(1);
  }

  // Join company room
  socket.emit("join_company", companyId);

  // 3. Test catalog queue asynchronously
  log("⏳ Submitting catalog upload to queue...", "cyan");
  // Create a mock PDF buffer (mock catalog logic will execute due to forced mock in tests/MOCK_GEMINI)
  const mockPdfBuffer = Buffer.from("%PDF-1.4 mock catalog content");
  const form = new FormData();
  form.append("catalog", new Blob([mockPdfBuffer], { type: "application/pdf" }), "test_catalog.pdf");

  const uploadRes = await fetch(`${BASE_URL}/products/upload-catalog?companyId=${companyId}`, {
    method: "POST",
    headers: { "x-test-bypass": "supersecretbypass" },
    body: form,
  });

  const uploadStatus = uploadRes.status;
  let uploadData = null;
  try {
    uploadData = await uploadRes.json();
  } catch (_) {}

  assert("Status is 202 (Accepted)", uploadStatus === 202, `Got ${uploadStatus}`);
  assert("Status field is 'accepted'", uploadData?.status === "accepted", JSON.stringify(uploadData));
  assert("Job ID is returned", !!uploadData?.data?.jobId, JSON.stringify(uploadData));

  const jobId = uploadData?.data?.jobId;

  if (jobId) {
    // 4. Wait for WebSocket status updates
    log(`👂 Listening for job_status events for job ID: ${jobId}`, "cyan");

    const jobResult = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        socket.off("job_status");
        resolve({ error: "Timeout waiting for job completion", status: "failed" });
      }, 15000); // Wait up to 15s

      socket.on("job_status", (data) => {
        log(`   [WS Event] Job Status: ${data.status}`, "yellow");
        if (data.jobId === jobId && (data.status === "completed" || data.status === "failed")) {
          clearTimeout(timeout);
          socket.off("job_status");
          resolve(data);
        }
      });
    });

    assert("Job finished (status completed or failed)", jobResult.status === "completed" || jobResult.status === "failed", JSON.stringify(jobResult));
    log(`Job final response: ${JSON.stringify(jobResult)}`, "white");

    // 5. Query from the background task endpoint
    const taskStatusRes = await request("GET", `/background-tasks/${jobId}`);
    assert("Task query status is 200", taskStatusRes.status === 200, `Got ${taskStatusRes.status}`);
    assert("Task DB status matches worker final status", taskStatusRes.data?.data?.status === jobResult.status, JSON.stringify(taskStatusRes.data));
  }

  // 6. Cleanup
  log("🧹 Cleaning up database...", "cyan");
  try {
    await prisma.backgroundTask.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
  } catch (err) {
    log(`  ⚠️ Cleanup error: ${err.message}`, "yellow");
  }
  socket.close();

  // Summary
  log("\n" + "═".repeat(62), "cyan");
  log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed && failed === 0 ? "green" : "red");
  log("═".repeat(62) + "\n", "cyan");

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

run().catch((err) => {
  log(`Fatal Error in test suite: ${err.message}`, "red");
  process.exit(1);
});
