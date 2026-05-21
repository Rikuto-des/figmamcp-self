import { describe, expect, it } from 'vitest';
import { normalizeNodeId, parseFigmaUrl } from './url-parser.js';

describe('parseFigmaUrl', () => {
  const cases: Array<[string, { fileKey: string; nodeId: string | null } | null]> = [
    [
      'https://www.figma.com/design/abc123XYZ/My-Mockup?node-id=1-23',
      { fileKey: 'abc123XYZ', nodeId: '1:23' },
    ],
    [
      'https://www.figma.com/design/abc123XYZ/My-Mockup?node-id=1:23',
      { fileKey: 'abc123XYZ', nodeId: '1:23' },
    ],
    [
      'https://www.figma.com/design/abc123XYZ/My-Mockup',
      { fileKey: 'abc123XYZ', nodeId: null },
    ],
    [
      'https://www.figma.com/file/abc123XYZ/Legacy?node-id=10-5',
      { fileKey: 'abc123XYZ', nodeId: '10:5' },
    ],
    [
      'https://www.figma.com/proto/abc123XYZ/Proto?node-id=2-34&type=design',
      { fileKey: 'abc123XYZ', nodeId: '2:34' },
    ],
    [
      'https://www.figma.com/board/abc123XYZ/Whiteboard?node-id=0-1',
      { fileKey: 'abc123XYZ', nodeId: '0:1' },
    ],
    [
      'https://figma.com/design/abc123XYZ/foo?node-id=1-2',
      { fileKey: 'abc123XYZ', nodeId: '1:2' },
    ],
    [
      'figma.com/design/abc123XYZ/?node-id=1-2',
      { fileKey: 'abc123XYZ', nodeId: '1:2' },
    ],
    [
      'https://www.figma.com/design/abc123XYZ/Test?something=else&node-id=99-100',
      { fileKey: 'abc123XYZ', nodeId: '99:100' },
    ],
    ['not-a-figma-url', null],
    ['https://example.com/design/abc/foo', null],
    ['', null],
    [
      'https://www.figma.com/design/abc123XYZ/My-Mockup?node-id=1-2#fragment',
      { fileKey: 'abc123XYZ', nodeId: '1:2' },
    ],
  ];

  it.each(cases)('parses %s', (input, expected) => {
    expect(parseFigmaUrl(input)).toEqual(expected);
  });
});

describe('normalizeNodeId', () => {
  it('converts dashes to colons', () => {
    expect(normalizeNodeId('1-23')).toBe('1:23');
    expect(normalizeNodeId('10-5-7')).toBe('10:5:7');
  });
  it('leaves already-colon form unchanged', () => {
    expect(normalizeNodeId('1:23')).toBe('1:23');
  });
});
