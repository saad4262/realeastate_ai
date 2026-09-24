import type { ChatEvent } from '@repo/ai/chat-events';

/**
 * Read the chat route's NDJSON stream.
 *
 * No dependency, because there is nothing to depend on: EventSource is the
 * only zero-dependency SSE client and it is GET-only, so it cannot carry the
 * conversation in a POST body. The body is parsed by hand either way.
 */
export async function readChatStream(
  response: Response,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();

  /**
   * The remainder buffer is the whole trick.
   *
   * A network chunk can end halfway through a JSON object, so splitting each
   * chunk on newlines and parsing the pieces loses the tail — reliably, and
   * only under load, which is the worst way to find out.
   */
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;

      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      try {
        onEvent(JSON.parse(line) as ChatEvent);
      } catch {
        // One malformed line must not end an answer that is still arriving.
      }
    }
  }

  const last = buffer.trim();
  if (last) {
    try {
      onEvent(JSON.parse(last) as ChatEvent);
    } catch {
      // A truncated final line means the connection died mid-object. The
      // caller already knows the stream ended; there is nothing to salvage.
    }
  }
}
