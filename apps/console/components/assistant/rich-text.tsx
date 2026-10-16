import { parseChatMarkdown, type InlineNode } from '@repo/core/markdown';
import styles from './assistant-panel.module.css';

/**
 * The assistant's answer, with its Markdown rendered rather than printed.
 *
 * The answer went into one pre-wrap `<div>`, so the person read literal
 * markers — "- **Day and time:** for example…". This is the console twin of
 * apps/web/app/chat/rich-text.tsx, over the same shared parser
 * (`@repo/core/markdown`); only the styles differ, and apps never import
 * each other.
 *
 * Nothing here builds HTML: the parser returns a tree, this turns it into
 * React elements, and React escapes every string — so model text cannot
 * become markup. It re-parses on every streamed delta; an unclosed `**`
 * shows as typed until its pair arrives.
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
          // A <strong> line, not an <h3>: a heading inside one turn would join the page outline a
          // screen reader navigates by, where an old turn's "What I found" is noise.
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
