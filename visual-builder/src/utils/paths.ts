// Filesystem path helpers.
//
// Paths reaching the frontend come from the OS file dialog, so they use the
// host's separator: "/" on macOS and Linux, "\" on Windows. Anything that
// splits on "/" alone is a Windows bug waiting to happen.

/** Directory portion of a path, handling both POSIX and Windows separators. */
export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  // A bare filename has no directory part. Returning "" rather than "." keeps
  // callers that guard on truthiness ("if (projectPath)") behaving sensibly.
  return index === -1 ? '' : path.slice(0, index);
}

/** Final component of a path, handling both separators. */
export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}
