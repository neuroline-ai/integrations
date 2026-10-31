import { z } from "zod";
import { defineAction, IntegrationError } from "../../core.ts";
import provider from "./_provider.ts";

export default defineAction(provider, {
  description:
    "Sends a plain-text email through Resend after the caller confirms the recipient and content. Returns the accepted email ID, not a delivery confirmation. Never retry an uncertain send without verification.",
  input: z.strictObject({
    to: z
      .string()
      .trim()
      .max(320)
      .pipe(z.email())
      .describe("Confirmed recipient email address."),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[^\r\n]+$/u)
      .describe("Email subject on one line, up to 500 characters."),
    text: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .describe("Plain-text email body, up to 50,000 characters."),
  }),
  async execute({ credentials, config, input, signal }) {
    signal.throwIfAborted();
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: config.from, ...input }),
        signal,
      });
      return z
        .object({ id: z.uuid() })
        .parse(await provider.response(response));
    } catch (error) {
      if (error instanceof IntegrationError && error.code !== "provider_error")
        throw error;
      throw new IntegrationError(
        "email_sending_uncertain",
        "Resend email sending could not be confirmed. The email may have been sent; do not retry without verification.",
      );
    }
  },
});
