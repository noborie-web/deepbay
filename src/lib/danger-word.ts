export type DangerWordMatch = {
  registeredWord: string
  normalizedWord: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeDangerWord(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^[\\"']+|[\\"']+$/g, '')
    .trim()
    .toLowerCase()
}

export function findDangerWordMatch(
  text: string,
  registeredWords: string[],
): DangerWordMatch | null {
  const normalizedText = text.normalize('NFKC').toLowerCase()

  for (const registeredWord of registeredWords) {
    const normalizedWord = normalizeDangerWord(registeredWord)
    // CSVの崩れなどで登録された「_」のような記号だけの値は判定に使わない。
    if (!normalizedWord || !/[\p{L}\p{N}]/u.test(normalizedWord)) continue

    if (/^[\x00-\x7F]+$/.test(normalizedWord)) {
      // 英数字の危険単語は単語境界で照合する。
      // 例: "Gun" は "GUNHED"、"Ero" は "HEROES" に一致させない。
      const boundaryPattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedWord)}($|[^\\p{L}\\p{N}])`,
        'iu',
      )
      if (boundaryPattern.test(normalizedText)) {
        return { registeredWord, normalizedWord }
      }
      continue
    }

    // 日本語など、空白で単語境界を判定できない文字列は従来どおり部分一致。
    if (normalizedText.includes(normalizedWord)) {
      return { registeredWord, normalizedWord }
    }
  }

  return null
}
