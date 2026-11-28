import type { FileDownload } from './fileDownload'

export const referenceTransferLimits = {
  latex: { rows: 500, mib: 20 },
  image: { rows: 300, mib: 25 },
} as const

export async function* referenceDownloadParts(
  total: number,
  limit: number,
  load: (offset: number, count: number) => Promise<FileDownload | null>,
) {
  let split = total > limit
  let index = 0
  for (let offset = 0; offset < total;) {
    const pending = [Math.min(limit, total - offset)]
    while (pending.length) {
      const count = pending.shift()!
      const file = await load(offset, count)
      if (!file) {
        const half = Math.ceil(count / 2)
        if (count < 2) throw new Error('The reference could not be downloaded.')
        split = true
        pending.unshift(half, count - half)
        continue
      }
      index++
      yield { offset, count, split, file: {
        ...file,
        filename: split ? file.filename.replace(/(\.[^.]+)$/, '_' + index + '$1') : file.filename,
      } }
      offset += count
    }
  }
}
