import { describe, expect, it } from 'vitest';
import { parseChatMarkdown, parseInline, type Block } from './markdown';

/**
 * The guide's answers, as they actually arrive.
 *
 * Every string in the first block below was copied from a real turn. The bug
 * this fixes was visible on screen: literal `**` around every suburb name,
 * because the chat rendered the model's Markdown as one plain paragraph.
 */

const plain = (b: Block) =>
  b.type === 'list' ? b.items.map((i) => i.map((n) => n.value).join('')) : b.content.map((n) => n.value).join('');

describe('inline emphasis', () => {
  it('pulls bold out and drops the markers', () => {
    expect(parseInline('I would start with **Pakenham** and **Narre Warren South**.')).toEqual([
      { type: 'text', value: 'I would start with ' },
      { type: 'bold', value: 'Pakenham' },
      { type: 'text', value: ' and ' },
      { type: 'bold', value: 'Narre Warren South' },
      { type: 'text', value: '.' },
    ]);
  });

  it('reads a doubled marker as bold, not as two italics', () => {
    // Guaranteed by `[^*]` inside each alternative rather than by their order
    // — flipping the alternation changes nothing, which was checked.
    const nodes = parseInline('**3 homes for sale**');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({ type: 'bold', value: '3 homes for sale' });
  });

  it('handles italic and code', () => {
    expect(parseInline('*about* `15 km`')).toEqual([
      { type: 'italic', value: 'about' },
      { type: 'text', value: ' ' },
      { type: 'code', value: '15 km' },
    ]);
  });

  it('leaves an unmatched marker exactly as written', () => {
    /**
     * A parser that guesses where emphasis was meant to end eats characters
     * the visitor never sees again. Showing what the model wrote is the
     * honest failure.
     */
    for (const raw of ['**not closed', 'a * b * c'.replace(/ /g, ' '), '****', '2 * 3 = 6']) {
      const joined = parseInline(raw)
        .map((n) => (n.type === 'text' ? n.value : `«${n.value}»`))
        .join('');
      expect(joined).not.toContain('«»');
    }
    expect(parseInline('**not closed')).toEqual([{ type: 'text', value: '**not closed' }]);
    expect(parseInline('****')).toEqual([{ type: 'text', value: '****' }]);
  });

  it('never crosses a line break', () => {
    // Otherwise a stray asterisk at the end of one sentence swallows the next.
    const nodes = parseInline('cheapest *here\nand* there');
    expect(nodes.every((n) => n.type === 'text')).toBe(true);
  });

  it('returns one empty node rather than nothing', () => {
    expect(parseInline('')).toEqual([{ type: 'text', value: '' }]);
  });
});

describe('blocks', () => {
  it('splits paragraphs on blank lines and keeps soft wraps inside one', () => {
    const blocks = parseChatMarkdown('First line\nstill first.\n\nSecond.');
    expect(blocks).toHaveLength(2);
    expect(plain(blocks[0]!)).toBe('First line\nstill first.');
    expect(plain(blocks[1]!)).toBe('Second.');
  });

  it('reads a numbered run as one ordered list', () => {
    const blocks = parseChatMarkdown(
      '1. **Are you buying or renting?**\n2. **What is your rough budget?**',
    );
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.type).toBe('list');
    if (list.type !== 'list') throw new Error('not a list');
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
    // The marker is gone and the bold survived it.
    expect(list.items[0]![0]).toEqual({ type: 'bold', value: 'Are you buying or renting?' });
  });

  it('reads dashes as an unordered list', () => {
    const blocks = parseChatMarkdown('- Pakenham\n- Officer');
    const list = blocks[0]!;
    if (list.type !== 'list') throw new Error('not a list');
    expect(list.ordered).toBe(false);
    expect(plain(list)).toEqual(['Pakenham', 'Officer']);
  });

  it('does not turn a sentence that starts with a dash into a list', () => {
    // "Every line a bullet, or it is not a list" — a paragraph whose first
    // line happens to begin with a marker is still a paragraph.
    const blocks = parseChatMarkdown('- Pakenham is south\nand it has transport.');
    expect(blocks[0]!.type).toBe('paragraph');
  });

  it('does not read multiplication as a bullet', () => {
    const blocks = parseChatMarkdown('2 * 3 is six');
    expect(blocks[0]!.type).toBe('paragraph');
    expect(plain(blocks[0]!)).toBe('2 * 3 is six');
  });

  it('reads a lone hashed line as a heading', () => {
    const blocks = parseChatMarkdown('## What I found\n\nThree homes.');
    expect(blocks[0]!.type).toBe('heading');
    expect(plain(blocks[0]!)).toBe('What I found');
    expect(blocks[1]!.type).toBe('paragraph');
  });

  it('drops nothing from a real answer', () => {
    /**
     * The whole point: every character the model wrote is either rendered or
     * was a marker. Compared by stripping markers from the source rather than
     * by writing the expected output twice.
     */
    const source = [
      "I'd start by looking at the suburbs nearest to Berwick: **Pakenham** and **Narre Warren South**.",
      '',
      'Before I search, a couple of quick questions:',
      '',
      '1. **Are you buying or renting?**',
      '2. **What is your rough budget?**',
    ].join('\n');

    const rendered = parseChatMarkdown(source)
      .map((b) => (b.type === 'list' ? (plain(b) as string[]).join('\n') : (plain(b) as string)))
      .join('\n');

    const expected = source
      .replace(/\*\*/g, '')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.replace(/^\d+\.\s+/, ''))
      .join('\n');

    expect(rendered).toBe(expected);
  });

  it('survives an empty or whitespace-only answer', () => {
    expect(parseChatMarkdown('')).toEqual([]);
    expect(parseChatMarkdown('\n\n   \n')).toEqual([]);
  });
});
