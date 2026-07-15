/**
 * Real-container proof for Signal text-style strict integer offsets.
 *
 * Hits a live bbernhard/signal-cli-rest-api container (not a fake /v2/send stub):
 *   production containerRpcRequest → logging forwarder → real container /v2/send
 *
 * Env:
 *   SIGNAL_CONTAINER_URL  base URL of the real container (default http://127.0.0.1:8080)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import {
  containerCheck,
  containerRpcRequest,
} from "../extensions/signal/src/client-container.ts";
import { parseContainerTextStyleEntry } from "../extensions/signal/src/client-container-text-style.ts";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";

interface CapturedSend {
  status: number;
  requestBody: string;
  responseBody: string;
}

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean): void {
  try {
    if (fn()) {
      passed += 1;
      console.log("  ok: %s", description);
    } else {
      failed += 1;
      console.log("  FAIL: %s", description);
    }
  } catch (err) {
    failed += 1;
    console.log("  FAIL: %s (%s)", description, err instanceof Error ? err.message : String(err));
  }
}

function info(message: string): void {
  console.log("  info: %s", message);
}

function headSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startLoggingForwarder(realBaseUrl: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  sends: CapturedSend[];
}> {
  const real = realBaseUrl.replace(/\/$/, "");
  const sends: CapturedSend[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const targetUrl = `${real}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && key.toLowerCase() !== "host") {
        headers[key] = value;
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, { method, headers, body });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `forwarder upstream failed: ${message}` }));
      return;
    }

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    if ((req.url ?? "").startsWith("/v2/send") && method === "POST") {
      sends.push({
        status: upstream.status,
        requestBody: body ? body.toString("utf8") : "",
        responseBody: responseBody.toString("utf8"),
      });
    }

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") {
        return;
      }
      outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    res.end(responseBody);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind logging forwarder");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sends,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function expectSendError(
  forwarderBaseUrl: string,
  textStyles: string[],
  message = "Bold text here",
): Promise<void> {
  try {
    await containerRpcRequest(
      "send",
      {
        account: "+15555550100",
        recipient: ["+15555550101"],
        message,
        "text-style": textStyles,
      },
      { baseUrl: forwarderBaseUrl, timeoutMs: 60_000 },
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Real container rejects unregistered accounts after accepting the JSON body.
    assert("real container returned Signal REST error (not connection failure)", () =>
      /Signal REST \d{3}:/.test(text),
    );
    info(`container error: ${text.slice(0, 240)}`);
    return;
  }
  assert("real container rejected unregistered send", () => false);
}

async function main(): Promise<void> {
  const realBaseUrl = (process.env.SIGNAL_CONTAINER_URL ?? "http://127.0.0.1:8080").replace(
    /\/$/,
    "",
  );
  const sha = headSha();
  console.log(`node=${process.version}`);
  console.log(`head=${sha}`);
  console.log(`real_container=${realBaseUrl}`);
  console.log("");

  console.log("[case 0] real container /v1/about");
  const aboutRes = await fetch(`${realBaseUrl}/v1/about`);
  const aboutText = await aboutRes.text();
  assert("/v1/about HTTP ok", () => aboutRes.ok);
  info(`status=${aboutRes.status}`);
  info(`body=${aboutText.slice(0, 500)}`);
  const aboutJson = (() => {
    try {
      return JSON.parse(aboutText) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  assert("/v1/about returns JSON", () => aboutJson !== null);
  if (aboutJson) {
    info(`keys=${Object.keys(aboutJson).sort().join(",")}`);
    if (typeof aboutJson.version === "string") {
      info(`version=${aboutJson.version}`);
    }
    if (typeof aboutJson.build === "number" || typeof aboutJson.build === "string") {
      info(`build=${String(aboutJson.build)}`);
    }
  }

  const check = await containerCheck(realBaseUrl, 30_000);
  assert("containerCheck(ok) against real image", () => check.ok === true);
  info(`containerCheck status=${String(check.status)} error=${String(check.error)}`);

  console.log("");
  console.log("[case 1] current-main Number() negative");
  assert('Number("0x10") path yields start=16', () => Number("0x10") === 16);
  info(`raw=0x10:4:ITALIC Number(start)=${Number("0x10")} Number(length)=${Number("4")}`);
  assert('Number("1e1") path yields start=10', () => Number("1e1") === 10);
  info(`raw=1e1:2:BOLD Number(start)=${Number("1e1")} Number(length)=${Number("2")}`);
  assert('Number("1.5") path yields length=1.5', () => Number("1.5") === 1.5);
  info(`raw=0:1.5:BOLD Number(start)=${Number("0")} Number(length)=${Number("1.5")}`);
  assert("strict helper rejects same hex token", () => parseStrictNonNegativeInteger("0x10") === undefined);
  assert("strict helper rejects same exponent token", () => parseStrictNonNegativeInteger("1e1") === undefined);
  assert("strict helper rejects same fraction token", () => parseStrictNonNegativeInteger("1.5") === undefined);

  console.log("");
  console.log("[case 2] positive — parseContainerTextStyleEntry rejects non-decimal");
  for (const raw of [
    "0x10:4:ITALIC",
    "1e1:2:BOLD",
    "0x0:0x4:BOLD",
    "1e0:4:BOLD",
    "0:1.5:BOLD",
    "0x10:4",
    ":4:BOLD",
  ]) {
    assert(`parseContainerTextStyleEntry(${JSON.stringify(raw)}) returns undefined`, () =>
      parseContainerTextStyleEntry(raw) === undefined,
    );
  }

  console.log("");
  console.log("[case 3] valid decimal spans still parse");
  assert("0:4:BOLD", () => {
    const parsed = parseContainerTextStyleEntry("0:4:BOLD");
    return parsed?.start === 0 && parsed.length === 4 && parsed.style === "BOLD";
  });
  assert("5:2:ITALIC", () => {
    const parsed = parseContainerTextStyleEntry("5:2:ITALIC");
    return parsed?.start === 5 && parsed.length === 2 && parsed.style === "ITALIC";
  });

  const forwarder = await startLoggingForwarder(realBaseUrl);
  try {
    console.log("");
    console.log("[case 4] production containerRpcRequest → real container /v2/send");
    info(`forwarder=${forwarder.baseUrl} → ${realBaseUrl}`);

    await expectSendError(forwarder.baseUrl, [
      "0:4:BOLD",
      "0x10:4:ITALIC",
      "1e1:2:BOLD",
      "0:1.5:BOLD",
    ]);
    const mixed = forwarder.sends.at(-1);
    assert("mixed send hit real /v2/send once", () => forwarder.sends.length === 1 && mixed !== undefined);
    if (mixed) {
      const payload = JSON.parse(mixed.requestBody) as {
        message?: string;
        text_mode?: string;
        number?: string;
        recipients?: string[];
      };
      assert('mixed: only decimal BOLD applied → "**Bold** text here"', () => payload.message === "**Bold** text here");
      assert('mixed: text_mode="styled"', () => payload.text_mode === "styled");
      info(`wire message=${JSON.stringify(payload.message)} text_mode=${JSON.stringify(payload.text_mode)}`);
      info(`dropped=3 (hex, exponent, fraction); survived=1 (0:4:BOLD)`);
      info(`real HTTP ${mixed.status}: ${mixed.responseBody.slice(0, 240)}`);
      assert("mixed: real container responded (non-2xx account/send failure expected)", () =>
        mixed.status >= 400,
      );
    }

    const beforeAllInvalid = forwarder.sends.length;
    await expectSendError(forwarder.baseUrl, ["0x0:0x4:BOLD", "1e0:4:BOLD"]);
    const allInvalid = forwarder.sends.at(-1);
    assert("all-invalid send hit real /v2/send once", () => forwarder.sends.length === beforeAllInvalid + 1);
    if (allInvalid) {
      const payload = JSON.parse(allInvalid.requestBody) as {
        message?: string;
        text_mode?: string;
      };
      assert("all-invalid: plain message unchanged", () => payload.message === "Bold text here");
      assert("all-invalid: text_mode omitted", () => payload.text_mode === undefined);
      info(`wire message=${JSON.stringify(payload.message)} has_text_mode=${payload.text_mode !== undefined}`);
      info(`real HTTP ${allInvalid.status}: ${allInvalid.responseBody.slice(0, 240)}`);
    }

    const beforeValid = forwarder.sends.length;
    await expectSendError(
      forwarder.baseUrl,
      ["0:4:BOLD", "5:4:ITALIC"],
      "Bold text here",
    );
    const valid = forwarder.sends.at(-1);
    assert("valid decimals hit real /v2/send once", () => forwarder.sends.length === beforeValid + 1);
    if (valid) {
      const payload = JSON.parse(valid.requestBody) as {
        message?: string;
        text_mode?: string;
      };
      assert("valid: styled markers applied", () =>
        typeof payload.message === "string" &&
        payload.message.includes("**") &&
        payload.message.includes("*"),
      );
      assert('valid: text_mode="styled"', () => payload.text_mode === "styled");
      info(`wire message=${JSON.stringify(payload.message)}`);
      info(`real HTTP ${valid.status}: ${valid.responseBody.slice(0, 240)}`);
    }
  } finally {
    await forwarder.close();
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`ALL PROOF ASSERTIONS: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();
