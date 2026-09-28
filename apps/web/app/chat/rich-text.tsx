import { parseChatMarkdown, type InlineNode } from '@repo/core/markdown';
import styles from './chat.module.css';

/**
 * The guide's answer, with its Markdown rendered rather than printed.
 *
 * The chat used to put `turn.text` straight into one `<p>`, so a visitor read
 * literal asterisks — "I'd start with **Pakenham** and **Narre Warren
 * South**" — and a numbered pair of questions arrived as one run-on line.
 *
 * ## Nothing here builds HTML
 *
 * `parseChatMarkdown` returns a tree and this turns that tree into React
 * elements. There is no `dangerouslySetInnerHTML` on this path, and React
 * escapes every string it is given, so the model's text cannot become markup
 * no matter what an anonymous visitor typed to provoke it. That is the whole
 * reason the parser returns data instead of a string.
 *
 * ## Streams safely
 *
 * This re-parses on every delta while a turn is streaming, which is cheap —
 * one pass over a few hundred characters — and means a half-written `**bold`
 * simply renders as the characters so far. The markers close themselves as
 * the rest arrives, with no flicker of a broken tag, because there are no
 * tags: an unmatched marker is left as literal text by construction.
 */

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'bold':
            return <strong key={i}>{node.value}</strong>;
          case 'italic':
            return <em key={i}>{node.value}</em>;
          case 'code':
            return (
              <code key={i} className={styles.msgCode}>
                {node.value}
              </code>
            );
          default:
            return <span key={i}>{node.value}</span>;
        }
      })}
    </>
  );
}

export function RichText({ text }: { text: string }) {
  const blocks = parseChatMarkdown(text);

  // A turn whose text is only whitespace renders nothing rather than an empty
  // bubble with padding in it.
  if (blocks.length === 0) return null;

  return (
    <div className={styles.msgText}>
      {blocks.map((block, i) => {
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={i} className={styles.msgList}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline nodes={item} />
                </li>
              ))}
            </List>
          );
        }

        if (block.type === 'heading') {
          /**
           * A <strong> line, not an <h3>.
           *
           * The chat log is already a `role="log"` of messages; putting real
           * headings inside one turn adds them to the document outline a
           * screen reader navigates by, where "What I found" from six turns
           * ago is noise. The visual weight is what the model meant.
           */
          return (
            <p key={i} className={styles.msgHeading}>
              <strong>
                <Inline nodes={block.content} />
              </strong>
            </p>
          );
        }

        return (
          <p key={i}>
            <Inline nodes={block.content} />
          </p>
        );
      })}
    </div>
  );
}
