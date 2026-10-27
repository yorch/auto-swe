/// git strips its ident "crud" characters from the ends of a name and refuses to
/// commit ("name consists only of disallowed characters") when nothing is left.
/// A name is usable only if it has at least one character outside that set.
const NON_CRUD_CHAR_RE = /[^\s.,:;<>"'\\]/u;

export function hasGitNameCharacter(name: string): boolean {
  return NON_CRUD_CHAR_RE.test(name);
}
