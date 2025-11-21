import type { Message } from "@/components/message";

type ToolInvocationState = "streaming" | "call" | "result";

type Snapshot = {
  messages: Message[];
  input: string;
  status: "ready" | "submitted" | "streaming";
  isInitializing: boolean;
  streamUrl: string | null;
  sandboxId: string | null;
};

type RealtimeSessionOptions = {
  api: string;
  body?: Record<string, any>;
  onError?: (error: Error) => void;
};

type SendOptions = {
  clearInput?: boolean;
};

type ToolInvocationPart = Extract<NonNullable<Message["parts"]>[number], { type: "tool-invocation" }>;

type StreamEvent =
  | { type: "text-delta"; delta?: string; textDelta?: string }
  | { type: "tool-input-available"; toolCallId: string; toolName?: string; input?: any }
  | { type: "tool-output-available"; toolCallId: string; output?: any }
  | { type: "screenshot-update"; screenshot?: string }
  | { type: "finish" }
  | { type: "error"; errorText?: string }
  | Record<string, any>;

export class RealtimeSession {
  private snapshot: Snapshot = {
    messages: [],
    input: "",
    status: "ready",
    isInitializing: true,
    streamUrl: null,
    sandboxId: null,
  };

  private readonly listeners = new Set<() => void>();
  private readonly api: string;
  private readonly baseBody?: Record<string, any>;
  private readonly onError?: (error: Error) => void;
  private abortController: AbortController | null = null;
  private currentTextId: string | null = null;
  private readonly toolMessageMap = new Map<string, string>();
  private activeScreenshotToolId: string | null = null;

  constructor(options: RealtimeSessionOptions) {
    this.api = options.api;
    this.baseBody = options.body;
    this.onError = options.onError;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  setInput(value: string) {
    this.updateSnapshot({ input: value });
  }

  setInitializing(flag: boolean) {
    this.updateSnapshot({ isInitializing: flag });
  }

  updateDesktop({ streamUrl, sandboxId }: { streamUrl: string | null; sandboxId: string | null }) {
    this.updateSnapshot({ streamUrl, sandboxId });
  }

  async sendMessage(text: string, options?: SendOptions) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.snapshot.status === "streaming" || this.snapshot.status === "submitted") return;
    if (this.snapshot.isInitializing) return;

    const userMessage: Message = {
      id: `user-${Date.now()}-${Math.random()}`,
      role: "user",
      content: trimmed,
    };

    const newMessages = [...this.snapshot.messages, userMessage];

    this.currentTextId = null;
    this.activeScreenshotToolId = null;

    this.updateSnapshot({
      messages: newMessages,
      input: options?.clearInput ? "" : this.snapshot.input,
      status: "submitted",
    });

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const payload = {
        messages: newMessages,
        timestamp: Date.now(),
        sandboxId: this.snapshot.sandboxId,
        ...(this.baseBody ?? {}),
      };

      const response = await fetch(this.api, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      this.updateSnapshot({ status: "streaming" });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            this.processLine(buffer);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          this.processLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      }

      this.abortController = null;
      this.updateSnapshot({ status: "ready" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.log("[STREAMING] Aborted");
      } else {
        console.error("[STREAMING ERROR]", error);
        if (this.onError) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      this.updateSnapshot({ status: "ready" });
    }
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateSnapshot({ status: "ready" });
  }

  private processLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) return;

    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch (err) {
      console.error("[PARSE ERROR]", err);
      return;
    }

    switch (event.type) {
      case "text-delta": {
        const delta = (event as any).delta || (event as any).textDelta || "";
        if (!delta) return;
        this.handleTextDelta(delta);
        break;
      }
      case "tool-input-available": {
        const toolEvent = event as any;
        if (!toolEvent.toolCallId) return;
        this.handleToolEvent(toolEvent.toolCallId, "call", {
          toolName: toolEvent.toolName,
          args: toolEvent.input,
          argsText: toolEvent.input ? JSON.stringify(toolEvent.input, null, 2) : undefined,
        });
        if (toolEvent.input?.action === "screenshot") {
          this.activeScreenshotToolId = toolEvent.toolCallId;
        }
        break;
      }
      case "tool-output-available": {
        const outputEvent = event as any;
        if (!outputEvent.toolCallId) return;
        this.handleToolEvent(outputEvent.toolCallId, "result", { result: outputEvent.output });
        if (outputEvent.output?.type === "image") {
          this.activeScreenshotToolId = outputEvent.toolCallId;
        }
        break;
      }
      case "screenshot-update": {
        const screenshotEvent = event as any;
        if (!this.activeScreenshotToolId) return;
        if (!screenshotEvent.screenshot) return;
        this.handleToolEvent(this.activeScreenshotToolId, "result", {
          result: { type: "image", data: screenshotEvent.screenshot },
        });
        break;
      }
      case "finish": {
        this.currentTextId = null;
        this.updateSnapshot({ status: "ready" });
        break;
      }
      case "error": {
        const errorEvent = event as any;
        const error = new Error(errorEvent.errorText || "Streaming error");
        if (this.onError) {
          this.onError(error);
        }
        this.updateSnapshot({ status: "ready" });
        break;
      }
      default:
        break;
    }
  }

  private handleTextDelta(delta: string) {
    if (!this.currentTextId) {
      const assistantMessage: Message = {
        id: `assistant-${Date.now()}-${Math.random()}`,
        role: "assistant",
        content: delta,
      };
      this.currentTextId = assistantMessage.id;
      this.replaceMessages([...this.snapshot.messages, assistantMessage]);
      return;
    }

    const updatedMessages = this.snapshot.messages.map((message) => {
      if (message.id !== this.currentTextId) return message;
      return {
        ...message,
        content: (message.content ?? "") + delta,
      };
    });

    this.replaceMessages(updatedMessages);
  }

  private handleToolEvent(
    toolCallId: string,
    state: ToolInvocationState,
    updates: Partial<ToolInvocationPart["toolInvocation"]>,
  ) {
    let messageId = this.toolMessageMap.get(toolCallId);

    if (!messageId) {
      messageId = `tool-${toolCallId}-${Date.now()}`;
      this.toolMessageMap.set(toolCallId, messageId);

      const invocation: ToolInvocationPart = {
        type: "tool-invocation",
        toolInvocation: {
          toolCallId,
          toolName: updates.toolName,
          state,
          args: updates.args,
          argsText: updates.argsText,
          result: updates.result,
        },
      };

      const toolMessage: Message = {
        id: messageId,
        role: "assistant",
        content: "",
        parts: [invocation],
      };

      this.currentTextId = null;
      this.replaceMessages([...this.snapshot.messages, toolMessage]);
      return;
    }

    const updatedMessages = this.snapshot.messages.map((message) => {
      if (message.id !== messageId || !message.parts) return message;

      const newParts = message.parts.map((part) => {
        if (part.type !== "tool-invocation") return part;
        if (part.toolInvocation.toolCallId !== toolCallId) return part;

        return {
          ...part,
          toolInvocation: {
            ...part.toolInvocation,
            ...updates,
            state,
          },
        };
      });

      return {
        ...message,
        parts: newParts,
      };
    });

    this.replaceMessages(updatedMessages);
  }

  private replaceMessages(messages: Message[]) {
    this.updateSnapshot({ messages });
  }

  private updateSnapshot(partial: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
