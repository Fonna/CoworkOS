/** Screen actions are distinct from document operations. Providers do not receive shell scripts. */
export type GuiAction =
  | { type: "click"; x: number; y: number; button: "left" | "right" }
  | { type: "type"; text: string }
  | { type: "key"; keys: string[] }
  | { type: "press"; elementId: string }
  | { type: "set_value"; elementId: string; value: string }
  | { type: "activate" };
export interface GuiObservation {
  capturedAt: string;
  width: number;
  height: number;
  image: Uint8Array;
  accessibilityText?: string;
}
export interface GuiProvider {
  id: string;
  observe(target: string, signal?: AbortSignal): Promise<GuiObservation>;
  act(target: string, action: GuiAction, signal?: AbortSignal): Promise<void>;
}
