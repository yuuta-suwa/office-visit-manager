import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies the X-Line-Signature header against the raw request body using
// the channel secret (HMAC-SHA256, base64). Must run on the raw bytes --
// never on a body that has already been JSON.parse()'d and re-stringified,
// since re-serialization is not guaranteed to reproduce byte-identical JSON.
export function verifyLineSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// Sending is opt-in and off by default: until LINE_SEND_ENABLED=true is set
// (with a fresh, non-leaked channel access token), every send is a no-op
// that only logs what would have been sent. This keeps the integration
// buildable and testable without ever reaching real production sending.
export function isLineSendEnabled() {
  return process.env.LINE_SEND_ENABLED === "true";
}

export type LineQuickReplyAction = {
  type: "action";
  action: { type: "postback"; label: string; data: string; displayText: string };
};

export type LineMessage = {
  type: "text";
  text: string;
  quickReply?: { items: LineQuickReplyAction[] };
};

export type LineSendResult = { dryRun: true } | { dryRun: false; ok: boolean; status: number; body: string };

async function callLineApi(path: string, payload: unknown): Promise<LineSendResult> {
  if (!isLineSendEnabled()) {
    return { dryRun: true };
  }
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured.");

  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { dryRun: false, ok: res.ok, status: res.status, body };
}

export function replyMessage(replyToken: string, messages: LineMessage[]) {
  return callLineApi("reply", { replyToken, messages });
}

export function pushMessage(to: string, messages: LineMessage[]) {
  return callLineApi("push", { to, messages });
}
