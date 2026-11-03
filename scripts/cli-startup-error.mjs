/** Keep the original Error/cause in memory; only a redacted summary reaches stderr. */
export function reportCliStartupError(error, env = process.env) {
  const redact = (value) => {
    let text = value;
    for (const [name, secret] of Object.entries(env))
      if (/(?:API_KEY|TOKEN|PASSWORD|SECRET)$/.test(name) && secret)
        text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  console.error(`CoworkOS: ${redact(error instanceof Error ? error.message : String(error))}`);
  if (["1", "true"].includes(env.ATRIA_DEBUG?.toLowerCase()) && error instanceof Error)
    console.error(redact(error.stack ?? error.message));
}
