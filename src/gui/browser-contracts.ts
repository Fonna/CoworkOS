import { z } from "zod";

const text = z.string().min(1).max(2048);
const timeout = z.number().int().min(1).max(30_000).optional();
const role = z.enum([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "tab",
  "menuitem",
  "heading",
  "dialog",
  "alert",
  "status",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "img",
  "slider",
  "spinbutton",
  "switch",
  "searchbox",
  "region",
  "group",
  "treeitem"
]);
const nth = z.number().int().min(0).max(10000).optional();
const atoms = [
  z.object({ kind: z.literal("role"), role, name: text, nth }).strict(),
  z.object({ kind: z.literal("label"), text, nth }).strict(),
  z.object({ kind: z.literal("text"), text, nth }).strict(),
  z.object({ kind: z.literal("testId"), text, nth }).strict()
] as const;
const atom = z.discriminatedUnion("kind", atoms);
const context = { scope: z.array(atom).max(4).optional(), frameId: text.optional() };
export const browserLocatorSchema = z.discriminatedUnion("kind", [
  atoms[0].extend(context),
  atoms[1].extend(context),
  atoms[2].extend(context),
  atoms[3].extend(context)
]);
export type BrowserLocatorAtom = z.infer<typeof atom>;
export type BrowserLocator = z.infer<typeof browserLocatorSchema>;
export const browserObservationSchema = z.enum(["aria", "screenshot", "both", "none"]);
export type BrowserObservationMode = z.infer<typeof browserObservationSchema>;
const point = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) }).strict();

/** Model inputs expose semantic locators, never page scripts, arbitrary executables or profiles. */
export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: text }).strict(),
  z
    .object({
      type: z.literal("click"),
      target: browserLocatorSchema,
      expectDownload: z.boolean().optional()
    })
    .strict(),
  z.object({ type: z.literal("fill"), target: browserLocatorSchema, value: z.string().max(16_384) }).strict(),
  z
    .object({
      type: z.literal("press"),
      target: browserLocatorSchema,
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ControlOrMeta+A"
      ])
    })
    .strict(),
  z.object({ type: z.literal("select"), target: browserLocatorSchema, value: text }).strict(),
  z
    .object({ type: z.literal("click_at"), ...point.shape, button: z.enum(["left", "right"]).optional() })
    .strict(),
  z.object({ type: z.literal("drag"), from: point, to: point }).strict(),
  z
    .object({
      type: z.literal("scroll"),
      ...point.shape,
      deltaX: z.number().finite().min(-10000).max(10000),
      deltaY: z.number().finite().min(-10000).max(10000)
    })
    .strict()
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserConditionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("element"),
      target: browserLocatorSchema,
      state: z.enum(["visible", "hidden", "attached", "detached", "enabled"])
    })
    .strict(),
  z.object({ type: z.literal("url"), url: text }).strict()
]);
export type BrowserCondition = z.infer<typeof browserConditionSchema>;

const observationOptions = {
  timeoutMs: timeout,
  observation: browserObservationSchema.optional(),
  frameId: text.optional()
};
export const browserInputs = {
  browser_open: z
    .object({ url: text, timeoutMs: timeout, observation: browserObservationSchema.optional() })
    .strict(),
  browser_observe: z.object({ pageId: text, ...observationOptions }).strict(),
  browser_act: z
    .object({
      pageId: text,
      action: browserActionSchema,
      observationId: text.optional(),
      ...observationOptions
    })
    .strict(),
  browser_wait: z.object({ pageId: text, condition: browserConditionSchema, ...observationOptions }).strict(),
  browser_close: z.object({ pageId: text.optional() }).strict()
};
export type BrowserOperation = keyof typeof browserInputs;

export class BrowserUseError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly dispatchStatus: "not_sent" | "sent" | "unknown" = "not_sent",
    readonly requiresObservation = false
  ) {
    super(message);
  }
}

export function browserUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrowserUseError("invalid_argument", "Browser Use requires an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new BrowserUseError(
      "invalid_argument",
      "Only HTTP(S) URLs without embedded credentials are supported"
    );
  return url.href;
}
