import { ConfigService } from '@nestjs/config';
import { commerceConfig } from './commerce.config';
import { describeMediaUpload, validateMediaFile } from './media-validate';

describe('media control characters', () => {
  const config = commerceConfig(new ConfigService({}));

  it.each([0, 8, 9, 10, 13, 31, 127, 47, 92])(
    'rejects filename character %i in both upload paths',
    (code) => {
      const name = `model${String.fromCharCode(code)}.obj`;
      expect(() =>
        describeMediaUpload({ name, bytesTotal: 10 }, config),
      ).toThrow('Invalid filename');
      expect(() =>
        validateMediaFile({ name, bytes: Buffer.from('v 0 0 0') }, config),
      ).toThrow('Invalid filename');
    },
  );

  it('allows UTF-8 names and OBJ tabs/newlines, but rejects binary controls', () => {
    const input = {
      name: '模型.obj',
      bytes: Buffer.from('v\t0 0 0\r\nv 1 1 1\n'),
    };
    expect(validateMediaFile(input, config).kind).toBe('MODEL3D');
    for (const code of [0, 8, 11, 12, 14, 31]) {
      expect(() =>
        validateMediaFile(
          {
            ...input,
            bytes: Buffer.from([118, code, 48]),
          },
          config,
        ),
      ).toThrow('File signature does not match');
    }
  });
});
