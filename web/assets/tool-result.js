/** Older Pi logs put failure inside result rather than on the execution event. */
export function toolExecutionFailed(event) {
  return event?.isError === true || event?.result?.isError === true || event?.result?.details?.ok === false;
}
