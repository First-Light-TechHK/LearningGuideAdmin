import type { LlmProvider } from '../providers/llm-provider.interface';
import { lectureLanguage, translateLectureText } from './lecture-language';

describe('Lecture answer language', () => {
  it('keeps interface locale separate and honors an explicit choice', () => {
    expect(lectureLanguage('¿Qué es una variable?', '', 'en-GB')).toBe('es');
    expect(
      lectureLanguage('什么是向量？Please answer in English.', '', 'zh-CN'),
    ).toBe('en-GB');
    expect(lectureLanguage('ベクトルとは何ですか？', '', 'zh-CN')).toBe('auto');
    expect(lectureLanguage('L1-F01', '什么是向量？', 'en-GB')).toBe('zh-CN');
  });

  it('restores the supplied formula and rejects altered references', async () => {
    const translate = (result: string) => {
      const provider: LlmProvider = {
        name: 'fixture',
        stream: () =>
          (async function* () {
            yield Promise.resolve(result);
          })(),
      };
      return translateLectureText(
        provider,
        { model: 'test', baseUrl: '', apiKey: '' },
        'See [Figure](refobj:fig) and $x$.',
        '¿Qué significa?',
        'es',
      );
    };
    await expect(translate('Véase ⟪0⟫ y ⟪1⟫.')).resolves.toBe(
      'Véase [Figure](refobj:fig) y $x$.',
    );
    await expect(
      translate('Véase [otro](refobj:unknown).'),
    ).resolves.toBeUndefined();
    await expect(translate('Véase ⟪0⟫.')).resolves.toBeUndefined();
  });
});
