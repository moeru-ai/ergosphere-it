const drivePattern = /^[a-z]:/i

/**
 * Checks that a manifest file path stays inside its core directory on every platform.
 *
 * A safe path is relative, uses `/` as its only separator, and has no empty, `.`, or `..` segment.
 * It has no backslash, no drive letter, and no NUL character.
 */
export function isSafeManifestPath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.includes('\0'))
    return false

  if (path.startsWith('/') || drivePattern.test(path))
    return false

  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}
