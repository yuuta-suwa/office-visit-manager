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

export type LineTextMessage = {
  type: "text";
  text: string;
  quickReply?: { items: LineQuickReplyAction[] };
};

// A colored, full-width button -- unlike quick replies, Flex Message
// buttons support custom color/size, which is the only way to make a LINE
// reply button visually prominent instead of a small quick-reply pill.
export type LineFlexButton = {
  type: "button";
  style: "primary" | "secondary";
  color?: string;
  height?: "sm" | "md";
  action: { type: "postback"; label: string; data: string; displayText: string };
};

export type LineFlexText = {
  type: "text";
  text: string;
  weight?: "regular" | "bold";
  size?: string;
  color?: string;
  wrap?: boolean;
};

export type LineFlexMessage = {
  type: "flex";
  altText: string;
  contents: {
    type: "bubble";
    body: {
      type: "box";
      layout: "vertical";
      spacing?: string;
      contents: (LineFlexText | LineFlexButton)[];
    };
  };
};

// LINE's native time picker: opens the platform time UI and returns the
// chosen value as postback.params.time ("HH:mm") on submit.
export type LineDatetimePickerMessage = {
  type: "template";
  altText: string;
  template: {
    type: "buttons";
    text: string;
    actions: [
      {
        type: "datetimepicker";
        label: string;
        data: string;
        mode: "time";
        initial?: string;
      },
    ];
  };
};

export type LineMessage = LineTextMessage | LineFlexMessage | LineDatetimePickerMessage;

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
