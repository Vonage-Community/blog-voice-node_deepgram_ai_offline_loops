// -----------------------------------------------------------------------------
// Real human transfer via the Vonage Voice API.
//
// When the caller asks for something out of scope, we don't just say "let me
// connect you" and hope — we actually transfer the live call leg to a support
// phone number. This is a PUT to the in-progress call with a `transfer` action
// and an inline NCCO that speaks a short transition line, then `connect`s the
// caller to SUPPORT_PHONE_NUMBER.
//
// Auth is a short-lived Vonage JWT signed (RS256) with the application's private
// key. We hand-roll it with node:crypto rather than pull in an SDK — it's a
// standard JWT with Vonage's `application_id`/`jti` claims, and keeping the
// dependency list minimal is a project value.
//
// This function never throws to *crash* a call: missing config is a logged
// no-op, and API failures are logged and rethrown so the caller's `.catch` can
// record the attempt without taking down the WebSocket server.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { randomUUID, sign } from "node:crypto";
import { HANDOFF_RESPONSE } from "../agent/fallback-responses.js";
import type { HandoffReason } from "../agent/tool-policy.js";

/** Base URL of the Vonage Voice API. */
export const VOICE_API_BASE = "https://api.nexmo.com";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Generate a short-lived (60s) Vonage JWT for Voice API calls, signed RS256 with
 * the application private key. Claims: application_id, iat, exp, jti.
 */
function generateVonageJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { application_id: appId, iat: now, exp: now + 60, jti: randomUUID() };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Transfer the active Vonage call `callUuid` to SUPPORT_PHONE_NUMBER.
 *
 * Reads its configuration from the environment (the same Vonage application
 * credentials the project already uses):
 *   VONAGE_APP_ID, VONAGE_PRIVATE_KEY_PATH  — to sign the JWT
 *   VONAGE_NUMBER                            — the `from` for the connect leg
 *   SUPPORT_PHONE_NUMBER                     — the human to ring
 *
 * If any of those is unset, the transfer is skipped with a warning (useful in
 * dev/tests where no real transfer target exists). On an API error it logs and
 * rethrows so the caller can note the failed attempt.
 */
export async function transferToHuman(callUuid: string, reason: HandoffReason): Promise<void> {
  const appId = process.env.VONAGE_APP_ID;
  const keyPath = process.env.VONAGE_PRIVATE_KEY_PATH;
  const from = process.env.VONAGE_NUMBER;
  const to = process.env.SUPPORT_PHONE_NUMBER;

  if (!appId || !keyPath || !from || !to) {
    console.warn(
      `[transfer] skipped (reason=${reason}): set VONAGE_APP_ID, VONAGE_PRIVATE_KEY_PATH, ` +
        "VONAGE_NUMBER, and SUPPORT_PHONE_NUMBER to enable real transfers",
    );
    return;
  }

  const privateKeyPem = readFileSync(keyPath, "utf8");
  const jwt = generateVonageJwt(appId, privateKeyPem);

  // The transition line is spoken by Vonage as part of the transfer NCCO — so
  // the promise ("let me connect you") and the action (the connect) are the same
  // event, rather than Deepgram promising a transfer we then try to execute.
  const ncco = [
    { action: "talk", text: HANDOFF_RESPONSE, language: "en-US" },
    { action: "connect", from, endpoint: [{ type: "phone", number: to }] },
  ];

  const response = await fetch(`${VOICE_API_BASE}/v1/calls/${encodeURIComponent(callUuid)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "transfer", destination: { type: "ncco", ncco } }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const message = `[transfer] Vonage API returned ${response.status} for call ${callUuid}: ${body}`;
    console.error(message);
    throw new Error(message);
  }

  console.log(`[transfer] call ${callUuid} → support ${to} (reason=${reason})`);
}
