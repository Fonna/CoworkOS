/** Classify structured provider errors without exposing their message, headers or credentials. */
export function modelErrorCode(message: string | undefined): "model_not_found" | undefined {
  if (!message || message.length > 65536) return;
  const body = message.replace(/^(?:HTTP(?: status(?: code)?)?\s*[:=]?\s*)?[45]\d{2}\s*:?\s*/i, "");
  try {
    const value = JSON.parse(body);
    const error = value?.error ?? value;
    if (error?.type === "model_not_found" || error?.code === "model_not_found") return "model_not_found";
  } catch {
    // Unstructured diagnostics are not evidence of a provider error code.
  }
}

/** Some transports discard nonstandard error envelopes; inspect a bounded copy for the probe. */
export async function responseModelErrorCode(response: Response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return modelErrorCode(body + decoder.decode());
      bytes += value.byteLength;
      if (bytes > 65536) return;
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    // Keep the HTTP diagnosis even when the provider body cannot be read.
  } finally {
    void reader.cancel().catch(() => {});
  }
}
