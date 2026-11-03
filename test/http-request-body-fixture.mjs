/** Decode only after receiving every byte, including split UTF-8 code points. */
export async function readFixtureRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
