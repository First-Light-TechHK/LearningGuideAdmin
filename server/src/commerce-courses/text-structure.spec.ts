import {
  exhibitCardPositions,
  matchTextPoints,
  parseTextStructure,
  stampLearningPoints,
} from './text-structure';

describe('parseTextStructure', () => {
  it('reads the learning point code the server stamped on a heading', () => {
    const points = parseTextStructure(
      '<h1 data-lp="T3">Why it matters</h1><p>Because.</p>',
    );
    expect(points).toEqual([
      { code: 'T3', title: 'Why it matters', hasBody: true, index: 0 },
    ]);
  });

  it('also reads a stamp written with single quotes and other attributes around it', () => {
    const points = parseTextStructure(
      "<h1 class='x' data-lp='T9' id='a'>Title</h1><p>Body</p>",
    );
    expect(points[0].code).toBe('T9');
    expect(points[0].title).toBe('Title');
  });

  it('gives a heading with no stamp a null code', () => {
    expect(parseTextStructure('<h1>New</h1><p>Body</p>')[0].code).toBeNull();
  });

  it('keeps an empty heading so the caller can flag it, and still counts its position', () => {
    const points = parseTextStructure(
      '<h1>First</h1><p>a</p><h1>  </h1><p>b</p><h1><br></h1><h1>Last</h1><p>c</p>',
    );
    expect(points.map((p) => p.title)).toEqual(['First', '', '', 'Last']);
    expect(points.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('says there is no body when the next heading follows at once', () => {
    const points = parseTextStructure('<h1>A</h1><h1>B</h1><p>Text</p>');
    expect(points.map((p) => p.hasBody)).toEqual([false, true]);
  });

  it('does not count an exhibit card as text under the heading', () => {
    const card =
      '<figure data-exhibit-code="E001" class="course-exhibit-card"><div><strong>Map</strong><div>IMAGE · E001</div><div>A long description</div></div></figure><p><br/></p>';
    const onlyCard = parseTextStructure(`<h1>A</h1>${card}<h1>B</h1><p>t</p>`);
    expect(onlyCard.map((p) => p.hasBody)).toEqual([false, true]);

    const cardAndText = parseTextStructure(`<h1>A</h1>${card}<p>Words</p>`);
    expect(cardAndText[0].hasBody).toBe(true);
  });

  it('treats sub-headings as body text and ignores an h2 as a learning point', () => {
    const points = parseTextStructure('<h1>A</h1><h2>Part one</h2>');
    expect(points).toHaveLength(1);
    expect(points[0].hasBody).toBe(true);
  });

  it('returns nothing for empty or heading-less text', () => {
    expect(parseTextStructure('')).toEqual([]);
    expect(parseTextStructure('<p>Just a paragraph</p>')).toEqual([]);
  });

  it('decodes the usual entities in a title', () => {
    expect(
      parseTextStructure('<h1>Tom &amp; Jerry&nbsp;</h1><p>x</p>')[0].title,
    ).toBe('Tom & Jerry');
  });
});

describe('stampLearningPoints', () => {
  it('writes the code on every heading, in order, and leaves the rest alone', () => {
    const html =
      '<h1>One</h1><p>a</p><h2>Sub</h2><h1 class="k">Two</h1><p>b</p>';
    expect(stampLearningPoints(html, ['T1', 'T2'])).toBe(
      '<h1 data-lp="T1">One</h1><p>a</p><h2>Sub</h2><h1 class="k" data-lp="T2">Two</h1><p>b</p>',
    );
  });

  it('replaces a stamp that is already there instead of doubling it', () => {
    expect(stampLearningPoints('<h1 data-lp="T9">One</h1>', ['T1'])).toBe(
      '<h1 data-lp="T1">One</h1>',
    );
  });

  it('removes the stamp from a heading that has no code to give', () => {
    expect(
      stampLearningPoints('<h1 data-lp="T1">A</h1><h1 data-lp="T2">B</h1>', [
        'T1',
      ]),
    ).toBe('<h1 data-lp="T1">A</h1><h1>B</h1>');
  });

  it('does not write a code that would break the attribute', () => {
    expect(stampLearningPoints('<h1>A</h1>', ['T"1><b>'])).toBe('<h1>A</h1>');
    expect(stampLearningPoints('<h1>A</h1>', ['T-1.2.3'])).toBe(
      '<h1 data-lp="T-1.2.3">A</h1>',
    );
  });

  it('is the identity on text with no heading', () => {
    const html = '<p>No headings</p>';
    expect(stampLearningPoints(html, [])).toBe(html);
  });

  it('is stable: stamping twice with the same codes changes nothing', () => {
    const once = stampLearningPoints('<h1>A</h1><h1>B</h1>', ['T1', 'T2']);
    expect(stampLearningPoints(once, ['T1', 'T2'])).toBe(once);
  });

  it('parses back what it stamped', () => {
    const stamped = stampLearningPoints(
      '<h1>A</h1><p>x</p><h1>B</h1><p>y</p>',
      ['T4', 'T5'],
    );
    expect(parseTextStructure(stamped).map((p) => p.code)).toEqual([
      'T4',
      'T5',
    ]);
  });
});

describe('exhibitCardPositions', () => {
  const card = (code: string, id: string) =>
    `<figure data-exhibit-code="${code}" data-exhibit-id="${id}" class="course-exhibit-card"><div><strong>Map</strong></div></figure><p><br/></p>`;
  const exhibit = { id: 'id-1', code: 'E001' };

  it('says under which Heading 1 the card sits, counting from 1', () => {
    const html = `<h1>A</h1><p>a</p><h1>B</h1><p>b</p><h1 data-lp="T3">C</h1>${card('E001', 'id-1')}<p>c</p>`;
    expect(exhibitCardPositions(html, exhibit)).toEqual([3]);
  });

  it('gives 0 for a card before the first Heading 1', () => {
    expect(
      exhibitCardPositions(
        `${card('E001', 'id-1')}<h1>A</h1><p>a</p>`,
        exhibit,
      ),
    ).toEqual([0]);
  });

  it('lists every card of the exhibit, and none of another exhibit', () => {
    const html = `<h1>A</h1>${card('E001', 'id-1')}<h1>B</h1>${card('E002', 'id-2')}${card('E001', 'id-1')}`;
    expect(exhibitCardPositions(html, exhibit)).toEqual([1, 2]);
    expect(exhibitCardPositions(html, { id: 'id-2', code: 'E002' })).toEqual([
      2,
    ]);
  });

  it('knows a card by its id alone, or by its code alone', () => {
    expect(
      exhibitCardPositions(
        '<h1>A</h1><figure data-exhibit-id="id-1"></figure>',
        exhibit,
      ),
    ).toEqual([1]);
    expect(
      exhibitCardPositions(
        "<h1>A</h1><figure data-exhibit-code='E001'></figure>",
        exhibit,
      ),
    ).toEqual([1]);
  });

  it('finds nothing in empty text or text without the exhibit', () => {
    expect(exhibitCardPositions(null, exhibit)).toEqual([]);
    expect(exhibitCardPositions('<h1>A</h1><p>E001</p>', exhibit)).toEqual([]);
  });
});

describe('matchTextPoints', () => {
  const rows = [
    { id: 'r1', code: 'T1', title: 'Alpha' },
    { id: 'r2', code: 'T2', title: 'Beta' },
    { id: 'r3', code: 'T3', title: 'Beta' },
  ];
  const ids = (match: Array<{ id: string } | null>) =>
    match.map((row) => row?.id ?? null);

  it('recognises a heading by its stamp even after the title changed', () => {
    expect(
      ids(matchTextPoints([{ code: 'T2', title: 'Renamed' }], rows)),
    ).toEqual(['r2']);
  });

  it('falls back to the first unused row with the same title, in order', () => {
    expect(
      ids(
        matchTextPoints(
          [
            { code: null, title: 'Beta' },
            { code: null, title: 'Beta' },
            { code: null, title: 'Beta' },
          ],
          rows,
        ),
      ),
    ).toEqual(['r2', 'r3', null]);
  });

  it('lets a stamp win over a title that another heading would also match', () => {
    expect(
      ids(
        matchTextPoints(
          [
            { code: null, title: 'Beta' },
            { code: 'T2', title: 'Beta' },
          ],
          rows,
        ),
      ),
    ).toEqual(['r3', 'r2']);
  });

  it('uses a stamp only once', () => {
    expect(
      ids(
        matchTextPoints(
          [
            { code: 'T1', title: 'Alpha' },
            { code: 'T1', title: 'Alpha' },
          ],
          rows,
        ),
      ),
    ).toEqual(['r1', null]);
  });

  it('does not recognise a stamp that no row carries and gives a new heading nothing', () => {
    expect(
      ids(
        matchTextPoints(
          [
            { code: 'T9', title: 'Unknown' },
            { code: null, title: 'New' },
          ],
          rows,
        ),
      ),
    ).toEqual([null, null]);
  });

  it('matches an empty title to an empty row', () => {
    expect(
      ids(
        matchTextPoints(
          [{ code: null, title: '' }],
          [{ id: 'e', code: 'T5', title: '' }],
        ),
      ),
    ).toEqual(['e']);
  });

  it('keeps the codes of the headings that stayed when a new one is put first', () => {
    expect(
      ids(
        matchTextPoints(
          [
            { code: null, title: 'Brand new' },
            { code: 'T1', title: 'Alpha' },
            { code: 'T2', title: 'Beta' },
          ],
          rows,
        ),
      ),
    ).toEqual([null, 'r1', 'r2']);
  });
});
