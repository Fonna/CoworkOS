/**
 * How a submitted answer re-enters the conversation.
 *
 * The model needs the answer as an ordinary user turn — that is how a paused
 * run continues — but it is not something the person typed into the composer.
 * The browser recognises this exact shape to render it against the question it
 * answers instead of as a fresh request, so the Dashboard and the transcript
 * have to agree on it. One definition, imported by both, is what keeps them
 * from drifting: a change here that the UI did not follow would silently turn
 * every answer back into a duplicate-looking user message.
 *
 * `web/assets/human-questions.js` holds the browser's copy and must match.
 */
export function humanAnswerTurn(question: string, answer: string): string {
  return `关于“${question}”，我的回答是：\n${answer}`;
}
