import { newcommandBlock, parseMacroLine } from './macros';

describe('macros', () => {
  it('parses newcommand and colon forms', () => {
    expect(parseMacroLine('\\newcommand{\\E}{\\mathbb{E}}')).toEqual({
      name: 'E',
      definition: '\\mathbb{E}',
      arity: 0,
    });
    expect(parseMacroLine('\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}')).toEqual({
      name: 'norm',
      definition: '\\left\\lVert #1 \\right\\rVert',
      arity: 1,
    });
    expect(parseMacroLine('\\KL[2]: D_{\\mathrm{KL}}(#1 \\,\\|\\, #2)')).toEqual({
      name: 'KL',
      definition: 'D_{\\mathrm{KL}}(#1 \\,\\|\\, #2)',
      arity: 2,
    });
    expect(parseMacroLine('E: \\mathbb{E}')).toEqual({ name: 'E', definition: '\\mathbb{E}', arity: 0 });
    expect(parseMacroLine('nonsense')).toBeNull();
  });
  it('emits newcommand definitions', () => {
    expect(
      newcommandBlock([
        { name: 'E', definition: '\\mathbb{E}', arity: 0 },
        { name: 'norm', definition: '\\lVert #1 \\rVert', arity: 1 },
      ]),
    ).toBe('\\newcommand{\\E}{\\mathbb{E}}\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}');
  });
});
